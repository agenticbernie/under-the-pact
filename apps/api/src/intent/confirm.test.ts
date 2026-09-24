import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import {
  PaymentIntent,
  validIntentFixture,
  type MerchantConfig,
  type PaymentIntent as PaymentIntentType
} from "@pact/shared"
import { validateIntent, type PolicyError } from "../policy/engine.js"
import { sealIntent, verifyIntentSeal } from "./seal.js"
import {
  assertConfirmed,
  decideConfirmation,
  type ConfirmationDecision
} from "./confirm.js"

const SECRET = "test-seal-secret-000000000000000000000001"
const DUMMY_WALLET = "11111111111111111111111111111111"
const DEVNET_MINT = "4zMMC9sEqf9MKyRbf3Tx3sQAr1BLWnCQcHjEXtGbm4o"
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
const ctx = { merchant }

/** Stable code on rejection, "OK" on success. */
const codeOf = (
  eff: Effect.Effect<unknown, PolicyError>
): Promise<string> =>
  Effect.runPromise(
    eff.pipe(
      Effect.as("OK"),
      Effect.catchAll((e) => Effect.succeed(e.code))
    )
  )

/** A sealed VALIDATED intent, exactly as /validate returns it. */
const validatedIntent = async (): Promise<PaymentIntentType> => {
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  const parsed = sealIntent({ ...base, status: "PARSED" as const }, SECRET)
  const validated = await Effect.runPromise(
    validateIntent(parsed, ctx, NOW).pipe(
      Effect.catchAll((e) =>
        Effect.die(new Error(`setup failed: ${e.code}`))
      )
    )
  )
  return sealIntent(validated, SECRET)
}

const decideCode = (
  intent: PaymentIntentType,
  decision: ConfirmationDecision,
  now: Date = NOW,
  secret: string = SECRET
): Promise<string> =>
  codeOf(decideConfirmation(intent, decision, ctx, secret, now))

describe("confirmation boundary (BER-137)", () => {
  it("confirms a sealed VALIDATED intent with a distinct event", async () => {
    const exit = await Effect.runPromiseExit(
      decideConfirmation(await validatedIntent(), "confirm", ctx, SECRET, NOW)
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") {
      return
    }
    expect(exit.value.intent.status).toBe("CONFIRMED")
    expect(exit.value.intent.confirmedAt).toBe(NOW.toISOString())
    expect(verifyIntentSeal(exit.value.intent, SECRET)).toBe(true)
    expect(exit.value.event).toMatchObject({
      type: "CONFIRMED",
      actor: "user"
    })
  })

  it("cancels cleanly and creates nothing", async () => {
    const exit = await Effect.runPromise(
      decideConfirmation(await validatedIntent(), "cancel", ctx, SECRET, NOW).pipe(
        Effect.catchAll(() => Effect.die(new Error("cancel must succeed")))
      )
    )
    expect(exit.intent.status).toBe("CANCELLED")
    expect(exit.event.type).toBe("CANCELLED")
    expect(verifyIntentSeal(exit.intent, SECRET)).toBe(true)
    // No transaction fields exist anywhere in Sprint 1 responses.
    expect("transactionSignature" in exit.intent).toBe(false)
  })

  it("cancels even when expired (backing out always works)", async () => {
    expect(
      await decideCode(
        await validatedIntent(),
        "cancel",
        new Date("2031-01-01T00:00:00.000Z")
      )
    ).toBe("OK")
  })

  it("rejects non-VALIDATED intents and tampered payloads", async () => {
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    const parsedOnly = sealIntent({ ...base, status: "PARSED" as const }, SECRET)
    expect(await decideCode(parsedOnly, "confirm")).toBe("NOT_VALIDATED")

    const forged = {
      ...(await validatedIntent()),
      amountMicroUsdc: 1
    } as PaymentIntentType
    expect(await decideCode(forged, "confirm")).toBe("INVALID_REQUEST")
    expect(await decideCode(forged, "cancel")).toBe("INVALID_REQUEST")
  })

  it("catches expiry between validate and confirm", async () => {
    expect(
      await decideCode(
        await validatedIntent(),
        "confirm",
        new Date("2030-01-01T00:15:00.001Z")
      )
    ).toBe("EXPIRED")
  })

  it("fails explicit without a seal secret", async () => {
    expect(await decideCode(await validatedIntent(), "confirm", NOW, "  ")).toBe(
      "INTERNAL_ERROR"
    )
  })
})

describe("execution gate (Sprint 2 contract)", () => {
  it("admits sealed, CONFIRMED, unexpired intents only", async () => {
    const exit = await Effect.runPromise(
      decideConfirmation(await validatedIntent(), "confirm", ctx, SECRET, NOW).pipe(
        Effect.catchAll(() => Effect.die(new Error("confirm must succeed")))
      )
    )
    const gateCode = (
      intent: PaymentIntentType,
      now: Date = NOW,
      secret: string = SECRET
    ): Promise<string> => codeOf(assertConfirmed(intent, secret, now))

    expect(await gateCode(exit.intent)).toBe("OK")
    expect(await gateCode(await validatedIntent())).toBe(
      "CONFIRMATION_REQUIRED"
    )

    const cancelled = await Effect.runPromise(
      decideConfirmation(await validatedIntent(), "cancel", ctx, SECRET, NOW).pipe(
        Effect.catchAll(() => Effect.die(new Error("cancel must succeed")))
      )
    )
    expect(await gateCode(cancelled.intent)).toBe("CONFIRMATION_REQUIRED")
    expect(
      await gateCode(exit.intent, new Date("2030-01-01T00:15:00.001Z"))
    ).toBe("EXPIRED")
    const forged = {
      ...exit.intent,
      amountMicroUsdc: 2
    } as PaymentIntentType
    expect(await gateCode(forged)).toBe("INVALID_REQUEST")
  })
})
