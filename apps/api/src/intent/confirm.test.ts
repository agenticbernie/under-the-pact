import { describe, expect, it } from "vitest"
import { Effect, Layer, Schema } from "effect"
import {
  PaymentIntent,
  createIntentId,
  validIntentFixture,
  type MerchantConfig,
  type PaymentIntent as PaymentIntentType
} from "@pact/shared"
import { validateIntent, type PolicyError } from "../policy/engine.js"
import {
  createMemoryLifecycleStore,
  LifecycleStore,
  lifecycleMemoryLayer,
  type LifecycleStoreApi
} from "../policy/lifecycle.js"
import { sealIntent, verifyIntentSeal } from "./seal.js"
import {
  assertConfirmed,
  decideConfirmation,
  type ConfirmationDecision
} from "./confirm.js"

const SECRET = "test-seal-secret-000000000000000000000001"
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
const ctx = { merchant }

/** Fresh isolated store per test — mirrors one app instance / isolate. */
const setup = () => {
  const api = createMemoryLifecycleStore()
  const layer = Layer.succeed(LifecycleStore, api)
  return { api, layer }
}
type Setup = ReturnType<typeof setup>

/** Stable code on rejection, "OK" on success. */
const codeOf = (
  eff: Effect.Effect<unknown, PolicyError, LifecycleStore>
): Promise<string> =>
  Effect.runPromise(
    eff.pipe(
      Effect.provide(lifecycleMemoryLayer()),
      Effect.as("OK"),
      Effect.catchAll((e) => Effect.succeed(e.code))
    )
  )

/**
 * A sealed VALIDATED intent recorded in the given store —
 * exactly what /validate returns and records.
 */
const validatedIntent = async (s: Setup): Promise<PaymentIntentType> => {
  // Unique ID per call: fixtures share one ID, and the store is keyed by it.
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  const unique = { ...base, intentId: createIntentId() }
  const parsed = sealIntent({ ...unique, status: "PARSED" as const }, SECRET)
  const validated = await Effect.runPromise(
    validateIntent(parsed, ctx, NOW).pipe(
      Effect.catchAll((e) =>
        Effect.die(new Error(`setup failed: ${e.code}`))
      )
    )
  )
  const sealed = sealIntent(validated, SECRET)
  s.api.recordValidated(sealed.intentId, sealed.seal as string, sealed.updatedAt)
  return sealed
}

const decideCode = (
  s: Setup,
  intent: PaymentIntentType,
  decision: ConfirmationDecision,
  now: Date = NOW,
  secret: string = SECRET
): Promise<string> =>
  codeOf(
    Effect.provide(decideConfirmation(intent, decision, ctx, secret, now), s.layer)
  )

const decideOrDie = (
  s: Setup,
  intent: PaymentIntentType,
  decision: ConfirmationDecision,
  now: Date = NOW
) =>
  Effect.runPromise(
    Effect.provide(decideConfirmation(intent, decision, ctx, SECRET, now), s.layer).pipe(
      Effect.catchAll(() => Effect.die(new Error(`${decision} must succeed`)))
    )
  )

const gateCode = (
  s: Setup,
  intent: PaymentIntentType,
  now: Date = NOW,
  secret: string = SECRET
): Promise<string> =>
  codeOf(Effect.provide(assertConfirmed(intent, secret, now), s.layer))

describe("confirmation boundary (BER-137)", () => {
  it("confirms a sealed VALIDATED intent with a distinct event", async () => {
    const s = setup()
    const decided = await decideOrDie(s, await validatedIntent(s), "confirm")
    expect(decided.intent.status).toBe("CONFIRMED")
    expect(decided.intent.confirmedAt).toBe(NOW.toISOString())
    expect(verifyIntentSeal(decided.intent, SECRET)).toBe(true)
    expect(decided.event).toMatchObject({
      type: "CONFIRMED",
      actor: "user"
    })
  })

  it("cancels cleanly and creates nothing", async () => {
    const s = setup()
    const decided = await decideOrDie(s, await validatedIntent(s), "cancel")
    expect(decided.intent.status).toBe("CANCELLED")
    expect(decided.event.type).toBe("CANCELLED")
    expect(verifyIntentSeal(decided.intent, SECRET)).toBe(true)
    // No transaction fields exist anywhere in Sprint 1 responses.
    expect("transactionSignature" in decided.intent).toBe(false)
  })

  it("cancels even when expired (backing out always works)", async () => {
    const s = setup()
    expect(
      await decideCode(
        s,
        await validatedIntent(s),
        "cancel",
        new Date("2031-01-01T00:00:00.000Z")
      )
    ).toBe("OK")
  })

  it("rejects non-VALIDATED intents and tampered payloads", async () => {
    const s = setup()
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    const parsedOnly = sealIntent({ ...base, status: "PARSED" as const }, SECRET)
    expect(await decideCode(s, parsedOnly, "confirm")).toBe("NOT_VALIDATED")
    // Cancel is gated too: PARSED/CONFIRMED/CANCELLED can never be
    // rewritten into contradictory terminal states (Qodo PR #8, Codex P2).
    expect(await decideCode(s, parsedOnly, "cancel")).toBe("NOT_VALIDATED")

    const forged = {
      ...(await validatedIntent(s)),
      amountMicroUsdc: 1
    } as PaymentIntentType
    expect(await decideCode(s, forged, "confirm")).toBe("INVALID_REQUEST")
    expect(await decideCode(s, forged, "cancel")).toBe("INVALID_REQUEST")
  })

  it("rejects replaying terminal states (no contradictory outcomes)", async () => {
    const s = setup()
    const confirmed = await decideOrDie(s, await validatedIntent(s), "confirm")
    // Replaying the exact CONFIRMED copy hits the status gate first.
    expect(await decideCode(s, confirmed.intent, "confirm")).toBe(
      "NOT_VALIDATED"
    )
    expect(await decideCode(s, confirmed.intent, "cancel")).toBe(
      "NOT_VALIDATED"
    )
    // Re-validating after decision cannot revive: the record stays
    // CONFIRMED (sticky terminals), so deciding the fresh copy is a
    // DUPLICATE_INTENT rather than a second outcome.
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    const revalidated = await Effect.runPromise(
      validateIntent(
        sealIntent(
          { ...base, intentId: confirmed.intent.intentId, status: "PARSED" as const },
          SECRET
        ),
        ctx,
        NOW
      ).pipe(
        Effect.catchAll((e) =>
          Effect.die(new Error(`setup failed: ${e.code}`))
        )
      )
    )
    const freshCopy = sealIntent(revalidated, SECRET)
    s.api.recordValidated(freshCopy.intentId, freshCopy.seal as string, freshCopy.updatedAt)
    expect(await decideCode(s, freshCopy, "confirm")).toBe("DUPLICATE_INTENT")
  })

  it("rejects decisions for intents never validated here", async () => {
    const s = setup()
    // Sealed but never recorded: no authoritative state exists.
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    const stranger = sealIntent(
      { ...base, status: "VALIDATED" as const },
      SECRET
    )
    expect(await decideCode(s, stranger, "confirm")).toBe("NOT_VALIDATED")
  })

  it("catches expiry between validate and confirm", async () => {
    const s = setup()
    expect(
      await decideCode(
        s,
        await validatedIntent(s),
        "confirm",
        new Date("2030-01-01T00:15:00.001Z")
      )
    ).toBe("EXPIRED")
  })

  it("fails explicit without a seal secret", async () => {
    const s = setup()
    expect(
      await decideCode(s, await validatedIntent(s), "confirm", NOW, "  ")
    ).toBe("INTERNAL_ERROR")
  })
})

describe("execution gate (Sprint 2 contract)", () => {
  it("admits the current CONFIRMED snapshot only", async () => {
    const s = setup()
    const decided = await decideOrDie(s, await validatedIntent(s), "confirm")

    expect(await gateCode(s, decided.intent)).toBe("OK")
    // A merely-VALIDATED intent never executes.
    expect(await gateCode(s, await validatedIntent(s))).toBe(
      "CONFIRMATION_REQUIRED"
    )

    const cancelledStore = setup()
    const cancelled = await decideOrDie(
      cancelledStore,
      await validatedIntent(cancelledStore),
      "cancel"
    )
    expect(await gateCode(cancelledStore, cancelled.intent)).toBe(
      "CONFIRMATION_REQUIRED"
    )
    expect(
      await gateCode(s, decided.intent, new Date("2030-01-01T00:15:00.001Z"))
    ).toBe("EXPIRED")
    const forged = {
      ...decided.intent,
      amountMicroUsdc: 2
    } as PaymentIntentType
    expect(await gateCode(s, forged)).toBe("INVALID_REQUEST")
    // Blank secret is an outage (500-class), not a client forgery.
    expect(await gateCode(s, decided.intent, NOW, "  ")).toBe("INTERNAL_ERROR")
  })

  it("rejects intents with no authoritative record", async () => {
    const s = setup()
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    const stranger = sealIntent(
      { ...base, status: "CONFIRMED" as const },
      SECRET
    )
    expect(await gateCode(s, stranger)).toBe("NOT_VALIDATED")
  })
})
