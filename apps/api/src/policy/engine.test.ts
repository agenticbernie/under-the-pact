import { describe, expect, it } from "vitest"
import { Cause, Effect, Schema } from "effect"
import {
  PaymentIntent,
  validIntentFixture,
  type MerchantConfig,
  type PaymentIntent as PaymentIntentType
} from "@pact/shared"
import {
  checkPolicyForBuild,
  validateIntent,
  type PolicyContext,
  type PolicyError
} from "./engine.js"

const DUMMY_WALLET = "11111111111111111111111111111111"
const DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const NOW = new Date("2030-01-01T00:00:00.000Z")

const merchant: MerchantConfig = {
  merchantId: "pact-coffee-demo",
  displayName: "Pact Coffee Demo",
  recipientWallet: DUMMY_WALLET,
  supportedTokenMint: DEVNET_MINT,
  network: "devnet",
  spendingLimitUsdc: 50,
  active: true
}
const ctx: PolicyContext = { merchant }

const parsed = (): PaymentIntentType => {
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  return { ...base, status: "PARSED" as const }
}

const validate = (
  intent: PaymentIntentType,
  context: PolicyContext = ctx,
  now: Date = NOW
) =>
  Effect.runPromiseExit(validateIntent(intent, context, now))

/** Stable code on rejection, "OK" on success. */
const codeOf = async (
  intent: PaymentIntentType,
  context: PolicyContext = ctx,
  now: Date = NOW
): Promise<string> => {
  const exit = await validate(intent, context, now)
  if (exit._tag === "Success") {
    return "OK"
  }
  const err = Cause.failureOption(exit.cause)
  if (err._tag === "None") {
    throw new Error("expected a typed PolicyError failure")
  }
  return (err.value as PolicyError).code
}

describe("policy engine (BER-134 + BER-135)", () => {
  it("validates a good PARSED intent and preserves its values", async () => {
    const exit = await validate(parsed())
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.status).toBe("VALIDATED")
      expect(exit.value.amountMicroUsdc).toBe(5_000_000)
      expect(exit.value.recipient).toBe(DUMMY_WALLET)
      expect(exit.value.tokenMint).toBe(DEVNET_MINT)
      expect(exit.value.updatedAt).toBe(NOW.toISOString())
    }
  })

  it("BER-134: UNKNOWN_MERCHANT for unknown id and inactive merchant", async () => {
    expect(await codeOf({ ...parsed(), merchantId: "starbucks" })).toBe(
      "UNKNOWN_MERCHANT"
    )
    expect(
      await codeOf(parsed(), { merchant: { ...merchant, active: false } })
    ).toBe("UNKNOWN_MERCHANT")
  })

  it("BER-134: WRONG_NETWORK and WRONG_MINT", async () => {
    expect(await codeOf({ ...parsed(), network: "mainnet-beta" })).toBe(
      "WRONG_NETWORK"
    )
    expect(await codeOf({ ...parsed(), tokenMint: DUMMY_WALLET })).toBe(
      "WRONG_MINT"
    )
  })

  it("only PARSED intents enter validation", async () => {
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    expect(await codeOf({ ...base, status: "DRAFT" })).toBe("NOT_VALIDATED")
  })

  it("keeps CONFIRMED out of public validation (Qodo/Codex PR #12)", async () => {
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    expect(await codeOf({ ...base, status: "CONFIRMED" })).toBe("NOT_VALIDATED")
  })

  it("checkPolicyForBuild re-checks CONFIRMED without resealing", async () => {
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    const confirmed = { ...base, status: "CONFIRMED" as const }
    const ok = await Effect.runPromiseExit(checkPolicyForBuild(confirmed, ctx, NOW))
    expect(ok._tag).toBe("Success")
    const expired = await Effect.runPromiseExit(
      checkPolicyForBuild(confirmed, ctx, new Date("2030-01-01T00:15:00.001Z"))
    )
    expect(expired._tag).toBe("Failure")
    const cancelled = await Effect.runPromiseExit(
      checkPolicyForBuild({ ...base, status: "CANCELLED" as const }, ctx, NOW)
    )
    expect(cancelled._tag).toBe("Failure")
  })

  it("BER-135: EXPIRED, INVALID_AMOUNT, RECIPIENT_MISMATCH", async () => {
    expect(
      await codeOf(parsed(), ctx, new Date("2030-01-01T00:15:00.001Z"))
    ).toBe("EXPIRED")
    expect(await codeOf({ ...parsed(), amountMicroUsdc: 0 })).toBe(
      "INVALID_AMOUNT"
    )
    expect(await codeOf({ ...parsed(), amountMicroUsdc: -100 })).toBe(
      "INVALID_AMOUNT"
    )
    expect(await codeOf({ ...parsed(), recipient: DEVNET_MINT })).toBe(
      "RECIPIENT_MISMATCH"
    )
  })

  it("BER-135: OVER_LIMIT with exact integer math", async () => {
    expect(await codeOf({ ...parsed(), amountMicroUsdc: 50_000_000 })).toBe(
      "OK"
    )
    expect(await codeOf({ ...parsed(), amountMicroUsdc: 50_000_001 })).toBe(
      "OVER_LIMIT"
    )
    // 0.1 USDC == 100_000 micro exactly (floats give 100000.00000000001).
    const tiny: PolicyContext = {
      merchant: { ...merchant, spendingLimitUsdc: 0.1 }
    }
    expect(await codeOf({ ...parsed(), amountMicroUsdc: 100_000 }, tiny)).toBe(
      "OK"
    )
    expect(await codeOf({ ...parsed(), amountMicroUsdc: 100_001 }, tiny)).toBe(
      "OVER_LIMIT"
    )
  })

  it("misconfigured limit is INTERNAL_ERROR, never a user code", async () => {
    const bad: PolicyContext = {
      merchant: { ...merchant, spendingLimitUsdc: NaN }
    }
    expect(await codeOf(parsed(), bad)).toBe("INTERNAL_ERROR")
  })

  it("first failure wins in documented order", async () => {
    expect(
      await codeOf(
        { ...parsed(), network: "mainnet-beta" },
        ctx,
        new Date("2030-01-01T00:15:00.001Z")
      )
    ).toBe("WRONG_NETWORK")
  })
})
