import { Effect } from "effect"
import {
  isExpired,
  PolicyErrorCode,
  type PaymentIntent
} from "@pact/shared"
import { validateIntent, PolicyError, type PolicyContext } from "../policy/engine.js"
import { LifecycleStore } from "../policy/lifecycle.js"
import { sealIntent, verifyIntentSeal } from "./seal.js"

/**
 * BER-137 / C-006 Confirmation Controller + C-003 lifecycle tail.
 *
 * The explicit authorization boundary: a VALIDATED intent becomes
 * CONFIRMED (user said yes) or CANCELLED (user said no). Cancelled
 * intents create no transaction — nothing in Sprint 1 creates one at all.
 *
 * Single-use lifecycle (Qodo PR #8 problem 2): decisions consume the
 * authoritative stored state exactly once per intent ID —
 *  seal verify → stored status must be VALIDATED (NOT_VALIDATED when
 *  unknown, DUPLICATE_INTENT when already decided) → confirm runs fresh
 *  policy, cancel skips it (expired-VALIDATED stays cancellable) →
 *  atomic consume → sealed terminal intent + distinct event.
 * Replay (confirm-after-cancel, double-confirm, stale copies) is rejected;
 * the Sprint 3 Postgres adapter replaces the memory store with no changes
 * here.
 */

export type ConfirmationDecision = "confirm" | "cancel"

export interface ConfirmationEvent {
  type: "CONFIRMED" | "CANCELLED"
  intentId: string
  actor: "user"
  at: string
}

export type ConfirmedIntent = PaymentIntent & { status: "CONFIRMED" }
export type CancelledIntent = PaymentIntent & { status: "CANCELLED" }

const eventFor = (
  type: ConfirmationEvent["type"],
  intentId: string,
  now: Date
): ConfirmationEvent => ({ type, intentId, actor: "user", at: now.toISOString() })

export const decideConfirmation = (
  intent: PaymentIntent,
  decision: ConfirmationDecision,
  ctx: PolicyContext,
  sealSecret: string,
  now: Date = new Date()
): Effect.Effect<
  { intent: ConfirmedIntent | CancelledIntent; event: ConfirmationEvent },
  PolicyError,
  LifecycleStore
> =>
  Effect.gen(function* () {
    if (sealSecret.trim().length === 0) {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: "Intent sealing is not configured."
        })
      )
    }
    if (!verifyIntentSeal(intent, sealSecret)) {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.INVALID_REQUEST,
          message:
            "Intent seal invalid — submit intents only as received from /validate."
        })
      )
    }
    // Lifecycle gate: the single-use state machine lives in the store,
    // not in the client-held copy.
    if (intent.status !== "VALIDATED") {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.NOT_VALIDATED,
          message: `Only VALIDATED intents can decide (got ${intent.status}).`
        })
      )
    }
    const store = yield* LifecycleStore
    const record = store.get(intent.intentId)
    if (record === undefined) {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.NOT_VALIDATED,
          message: "Unknown intent — validate it through this server first."
        })
      )
    }
    if (record.status !== "VALIDATED") {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.DUPLICATE_INTENT,
          message: `Intent already decided (${record.status}).`
        })
      )
    }

    if (decision === "cancel") {
      // Cancel skips policy: backing out always works, even when expired.
      // It produces no transaction by construction.
      const cancelled = sealIntent(
        { ...intent, status: "CANCELLED", updatedAt: now.toISOString() },
        sealSecret
      ) as CancelledIntent
      if (
        !store.consume(intent.intentId, "VALIDATED", {
          status: "CANCELLED",
          seal: cancelled.seal as string,
          updatedAt: now.toISOString()
        })
      ) {
        return yield* Effect.fail(
          new PolicyError({
            code: PolicyErrorCode.DUPLICATE_INTENT,
            message: "Intent already decided."
          })
        )
      }
      return {
        intent: cancelled,
        event: eventFor("CANCELLED", intent.intentId, now)
      }
    }

    // Confirm runs full policy on a fresh clock: expiry between validate
    // and confirm is caught here, never executed.
    const revalidated = yield* validateIntent(intent, ctx, now)
    const confirmed = sealIntent(
      {
        ...revalidated,
        status: "CONFIRMED",
        confirmedAt: now.toISOString(),
        updatedAt: now.toISOString()
      },
      sealSecret
    ) as ConfirmedIntent
    if (
      !store.consume(intent.intentId, "VALIDATED", {
        status: "CONFIRMED",
        seal: confirmed.seal as string,
        updatedAt: now.toISOString()
      })
    ) {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.DUPLICATE_INTENT,
          message: "Intent already decided."
        })
      )
    }
    return {
      intent: confirmed,
      event: eventFor("CONFIRMED", intent.intentId, now)
    }
  })

/**
 * Execution gate for Sprint 2 (BER-140): the transaction builder consumes
 * ONLY Intents whose authoritative stored snapshot is CONFIRMED with a
 * matching seal. Older sealed copies (PARSED/VALIDATED snapshots, mutated
 * payloads) and terminal-but-cancelled intents are all refused.
 */
export const assertConfirmed = (
  intent: PaymentIntent,
  sealSecret: string,
  now: Date = new Date()
): Effect.Effect<ConfirmedIntent, PolicyError, LifecycleStore> =>
  Effect.gen(function* () {
    // Operator outage vs bad input must stay distinguishable (Codex P2):
    // a blank secret is logged 500 INTERNAL_ERROR, a bad seal is 400.
    if (sealSecret.trim().length === 0) {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: "Intent sealing is not configured."
        })
      )
    }
    if (!verifyIntentSeal(intent, sealSecret)) {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Confirmed intent seal invalid."
        })
      )
    }
    const store = yield* LifecycleStore
    const record = store.get(intent.intentId)
    if (record === undefined) {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.NOT_VALIDATED,
          message: "No authoritative record — confirm through this server first."
        })
      )
    }
    if (record.status !== "CONFIRMED" || record.seal !== intent.seal) {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.CONFIRMATION_REQUIRED,
          message: `Execution requires the current CONFIRMED snapshot (stored: ${record.status}).`
        })
      )
    }
    if (isExpired(intent, now)) {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.EXPIRED,
          message: "Confirmed intent expired before execution."
        })
      )
    }
    return intent as ConfirmedIntent
  })
