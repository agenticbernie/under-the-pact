import { Data, Effect } from "effect"
import {
  decimalUsdcToMicro,
  isExpired,
  PolicyErrorCode,
  type MerchantConfig,
  type PaymentIntent
} from "@pact/shared"

/**
 * BER-134 + BER-135 / C-005 Deterministic Policy Engine.
 *
 * Pure function of (intent, merchant, now): no UI, no LLM, no network,
 * no wallet. AI output and client input are untrusted until they pass here.
 * Every rejection carries a stable machine-readable code.
 *
 * Check order is fixed and documented (first failure wins):
 *  1. UNKNOWN_MERCHANT — id mismatch or inactive merchant (134)
 *  2. WRONG_NETWORK   — intent network != merchant network (134)
 *  3. WRONG_MINT      — tokenMint != configured mint (token is schema-USDC) (134)
 *  4. NOT_VALIDATED   — only PARSED / VALIDATED / CONFIRMED intents enter:
 *     fresh parses, re-validation, and build-time re-checks (137 + 140 gates)
 *  5. EXPIRED         — expiry <= now; expired never reaches confirmation (135)
 *  6. INVALID_AMOUNT  — defensive: schema already guarantees positive int (135)
 *  7. RECIPIENT_MISMATCH — recipient != registered merchant wallet (135)
 *  8. OVER_LIMIT      — amount > spending limit, exact integer math (135)
 *  ok -> VALIDATED    — the same values flow to tx construction (Sprint 2)
 */

export class PolicyError extends Data.TaggedError("PolicyError")<{
  code:
    | typeof PolicyErrorCode.UNKNOWN_MERCHANT
    | typeof PolicyErrorCode.WRONG_NETWORK
    | typeof PolicyErrorCode.WRONG_MINT
    | typeof PolicyErrorCode.NOT_VALIDATED
    | typeof PolicyErrorCode.CONFIRMATION_REQUIRED
    | typeof PolicyErrorCode.MERCHANT_ATA_MISSING
    | typeof PolicyErrorCode.DUPLICATE_INTENT
    | typeof PolicyErrorCode.EXPIRED
    | typeof PolicyErrorCode.INVALID_AMOUNT
    | typeof PolicyErrorCode.RECIPIENT_MISMATCH
    | typeof PolicyErrorCode.OVER_LIMIT
    | typeof PolicyErrorCode.INTERNAL_ERROR
    | typeof PolicyErrorCode.INVALID_REQUEST
  message: string
}> {}

export interface PolicyContext {
  merchant: MerchantConfig
}

export type ValidatedIntent = PaymentIntent & {
  status: "VALIDATED" | "CONFIRMED"
}

const fail = (
  code: PolicyError["code"],
  message: string
): Effect.Effect<never, PolicyError> =>
  Effect.fail(new PolicyError({ code, message }))

export const validateIntent = (
  intent: PaymentIntent,
  ctx: PolicyContext,
  now: Date = new Date()
): Effect.Effect<ValidatedIntent, PolicyError> =>
  Effect.gen(function* () {
    const m = ctx.merchant

    // BER-134 — identity, network, mint.
    if (!m.active || intent.merchantId !== m.merchantId) {
      return yield* fail(
        PolicyErrorCode.UNKNOWN_MERCHANT,
        `Unknown or inactive merchant: ${intent.merchantId}.`
      )
    }
    if (intent.network !== m.network) {
      return yield* fail(
        PolicyErrorCode.WRONG_NETWORK,
        `Unsupported network ${intent.network}; expected ${m.network}.`
      )
    }
    if (intent.token !== "USDC" || intent.tokenMint !== m.supportedTokenMint) {
      return yield* fail(
        PolicyErrorCode.WRONG_MINT,
        "Only the configured USDC mint is accepted."
      )
    }

    // PARSED enters fresh; VALIDATED re-validates; CONFIRMED re-checks at
    // build time (BER-140: config may have changed since confirmation).
    // Nothing else — especially CANCELLED — is consumable here.
    if (
      intent.status !== "PARSED" &&
      intent.status !== "VALIDATED" &&
      intent.status !== "CONFIRMED"
    ) {
      return yield* fail(
        PolicyErrorCode.NOT_VALIDATED,
        `Intent status ${intent.status} cannot enter validation; expected PARSED, VALIDATED, or CONFIRMED.`
      )
    }

    // BER-135 — expiry, amount, recipient, limit.
    if (isExpired(intent, now)) {
      return yield* fail(
        PolicyErrorCode.EXPIRED,
        `Payment intent expired at ${intent.expiry}.`
      )
    }
    if (!Number.isSafeInteger(intent.amountMicroUsdc) || intent.amountMicroUsdc <= 0) {
      return yield* fail(
        PolicyErrorCode.INVALID_AMOUNT,
        "Amount must be a positive integer number of micro-USDC."
      )
    }
    if (intent.recipient !== m.recipientWallet) {
      return yield* fail(
        PolicyErrorCode.RECIPIENT_MISMATCH,
        "Recipient is not the registered merchant wallet."
      )
    }
    // Exact integer math via the shared choke point — never floats:
    // String(0.1) -> "0.1" decodes exactly, unlike 0.1 * 1e6.
    const limitMicro = decimalUsdcToMicro(String(m.spendingLimitUsdc))
    if (limitMicro === null || limitMicro <= 0) {
      return yield* fail(
        PolicyErrorCode.INTERNAL_ERROR,
        "Merchant spending limit is misconfigured."
      )
    }
    if (intent.amountMicroUsdc > limitMicro) {
      return yield* fail(
        PolicyErrorCode.OVER_LIMIT,
        `Amount exceeds the ${m.spendingLimitUsdc} USDC spending limit.`
      )
    }

    // Preserve CONFIRMED on build-time re-checks (BER-140): the status is
    // lifecycle position, and re-validation must not move it backwards.
    // Fresh PARSED intents graduate to VALIDATED here.
    return {
      ...intent,
      status: intent.status === "PARSED" ? "VALIDATED" : intent.status,
      updatedAt: now.toISOString()
    } as ValidatedIntent
  })
