import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import {
  PaymentIntent,
  validIntentFixture,
  type PaymentIntent as PaymentIntentType
} from "@pact/shared"
import { createApp } from "./app.js"
import { validateIntent } from "./policy/engine.js"
import { MerchantRegistryLive, MerchantRegistry } from "./merchant/registry.js"
import { PactConfigLive } from "./config.js"
import { sealIntent, verifyIntentSeal } from "./intent/seal.js"

const TEST_SEAL_SECRET = "test-seal-secret-000000000000000000000001"

process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"
process.env["MERCHANT_ACTIVE"] = "true"
process.env["INTENT_SEAL_SECRET"] = TEST_SEAL_SECRET

/** Sealed VALIDATED intent, exactly as /validate returns it. */
const validatedIntent = async (): Promise<PaymentIntentType> => {
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  const parsed = sealIntent({ ...base, status: "PARSED" as const }, TEST_SEAL_SECRET)
  const merchant = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* MerchantRegistry
      return registry.getMerchant()
    }).pipe(
      Effect.provide(MerchantRegistryLive),
      Effect.provide(PactConfigLive)
    )
  )
  const validated = await Effect.runPromise(
    validateIntent(parsed, { merchant }).pipe(
      Effect.catchAll((e) =>
        Effect.die(new Error(`setup failed: ${e.code}`))
      )
    )
  )
  return sealIntent(validated, TEST_SEAL_SECRET)
}

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/api/intent/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

/**
 * BER-137 plumbing: only sealed VALIDATED intents decide; every other
 * shape fails in-contract before any state change.
 */
describe("POST /api/intent/confirm", () => {
  it("confirms with a distinct auditable event", async () => {
    const app = createApp()
    const res = await post(app, {
      intent: await validatedIntent(),
      decision: "confirm"
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      intent: PaymentIntentType
      event: { type: string; intentId: string; actor: string; at: string }
    }
    expect(body.ok).toBe(true)
    expect(body.intent.status).toBe("CONFIRMED")
    expect(typeof body.intent.confirmedAt).toBe("string")
    expect(verifyIntentSeal(body.intent, TEST_SEAL_SECRET)).toBe(true)
    expect(body.event.type).toBe("CONFIRMED")
    expect(body.event.actor).toBe("user")
    expect(body.event.intentId).toBe(body.intent.intentId)
  })

  it("cancels with no transaction and a CANCELLED event", async () => {
    const app = createApp()
    const res = await post(app, {
      intent: await validatedIntent(),
      decision: "cancel"
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      intent: PaymentIntentType
      event: { type: string }
    }
    expect(body.intent.status).toBe("CANCELLED")
    expect(body.event.type).toBe("CANCELLED")
    expect(verifyIntentSeal(body.intent, TEST_SEAL_SECRET)).toBe(true)
  })

  it("rejects non-VALIDATED, tampered, and malformed confirmations", async () => {
    const app = createApp()
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())

    const parsedOnly = await post(app, {
      intent: sealIntent({ ...base, status: "PARSED" as const }, TEST_SEAL_SECRET),
      decision: "confirm"
    })
    expect(parsedOnly.status).toBe(422)

    const forged = await post(app, {
      intent: { ...(await validatedIntent()), amountMicroUsdc: 1 },
      decision: "confirm"
    })
    expect(forged.status).toBe(400)

    const badDecision = await post(app, {
      intent: await validatedIntent(),
      decision: "maybe"
    })
    expect(badDecision.status).toBe(400)
  })

  it("catches expiry at confirmation time", async () => {
    const app = createApp()
    const stale = sealIntent(
      { ...(await validatedIntent()), expiry: "2020-01-01T00:00:00.000Z" },
      TEST_SEAL_SECRET
    )
    const res = await post(app, { intent: stale, decision: "confirm" })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("EXPIRED")
  })
})
