import { Effect } from "effect"
import {
  isExpired,
  PolicyErrorCode,
  type PaymentIntent
} from "@pact/shared"
import { validateIntent, PolicyError, type PolicyContext } from "../policy/engine.js"
import { sealIntent, verifyIntentSeal } from "./seal.js"

/**
 * BER-137 / C-006 Confirmation Controller + C-003 lifecycle tail.
 *
 * The explicit authorization boundary: a VALIDATED intent becomes
 * CONFIRMED (user said yes) or CANCELLED (user said no). Cancelled
 * intents create no transaction — nothing in Sprint 1 creates one at all.
 *
 * Every path re-verifies the seal and re-runs policy with a fresh clock:
 * - Only VALIDATED intents enter (PARSED must validate first).
 * - Expired-between-validate-and-confirm is caught here, never executed.
 * - The confirmation payload cannot smuggle new amount/recipient/token/
 *   network values: any change breaks the seal (400) before policy runs.
 * - Confirmation is returned as intent + distinct event (auditable;
 *   persisted by Sprint 3 audit storage).
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

export const decideConfirmation = (
  intent: PaymentIntent,
  decision: ConfirmationDecision,
  ctx: PolicyContext,
  sealSecret: string,
  now: Date = new Date()
): Effect.Effect<
  { intent: ConfirmedIntent | CancelledIntent; event: ConfirmationEvent },
  PolicyError
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
    if (decision === "cancel") {
      // Cancel needs no policy: backing out always works, even when expired.
      // It produces no transaction by construction.
      const cancelled = sealIntent(
        { ...intent, status: "CANCELLED", updatedAt: now.toISOString() },
        sealSecret
      ) as CancelledIntent
      return {
        intent: cancelled,
        event: {
          type: "CANCELLED",
          intentId: intent.intentId,
          actor: "user",
          at: now.toISOString()
        } as ConfirmationEvent
      }
    }
    // Confirm: VALIDATED only, then full policy with a fresh clock.
    if (intent.status !== "VALIDATED") {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.NOT_VALIDATED,
          message: `Only VALIDATED intents can be confirmed (got ${intent.status}).`
        })
      )
    }
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
    return {
      intent: confirmed,
      event: {
        type: "CONFIRMED",
        intentId: intent.intentId,
        actor: "user",
        at: now.toISOString()
      } as ConfirmationEvent
    }
  })

/**
 * Execution gate for Sprint 2 (BER-140): the transaction builder consumes
 * ONLY Intents that pass here — sealed, CONFIRMED, unexpired.
 * Cancelled/expired/forged intents cannot reach signing or submission.
 */
export const assertConfirmed = (
  intent: PaymentIntent,
  sealSecret: string,
  now: Date = new Date()
): Effect.Effect<ConfirmedIntent, PolicyError> =>
  Effect.gen(function* () {
    if (
      sealSecret.trim().length === 0 ||
      !verifyIntentSeal(intent, sealSecret)
    ) {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Confirmed intent seal invalid."
        })
      )
    }
    if (intent.status !== "CONFIRMED") {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.CONFIRMATION_REQUIRED,
          message: `Execution requires a CONFIRMED intent (got ${intent.status}).`
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
