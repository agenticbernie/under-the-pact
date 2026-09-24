import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  PaymentIntent,
  createIntentId,
  validIntentFixture,
  type PaymentIntent as PaymentIntentType
} from "@pact/shared"
import { createApp } from "./app.js"
import { sealIntent, verifyIntentSeal } from "./intent/seal.js"

const TEST_SEAL_SECRET = "test-seal-secret-000000000000000000000001"

process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"
process.env["MERCHANT_ACTIVE"] = "true"
process.env["INTENT_SEAL_SECRET"] = TEST_SEAL_SECRET

const postValidate = (app: ReturnType<typeof createApp>, intent: unknown) =>
  app.request("/api/intent/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent })
  })

/**
 * Sealed VALIDATED intent obtained through POST /validate — the only way
 * a record enters the lifecycle store, exactly like production flow.
 */
const validatedIntent = async (
  app: ReturnType<typeof createApp>
): Promise<PaymentIntentType> => {
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  // Unique ID per call: the lifecycle store is keyed by intent ID.
  const unique = { ...base, intentId: createIntentId() }
  const parsed = sealIntent({ ...unique, status: "PARSED" as const }, TEST_SEAL_SECRET)
  const res = await postValidate(app, parsed)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; intent: PaymentIntentType }
  expect(body.ok).toBe(true)
  return body.intent
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
      intent: await validatedIntent(app),
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
      intent: await validatedIntent(app),
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
      intent: { ...(await validatedIntent(app)), amountMicroUsdc: 1 },
      decision: "confirm"
    })
    expect(forged.status).toBe(400)

    const badDecision = await post(app, {
      intent: await validatedIntent(app),
      decision: "maybe"
    })
    expect(badDecision.status).toBe(400)
  })

  it("rejects replay of decided intents as DUPLICATE_INTENT", async () => {
    const app = createApp()
    const first = await validatedIntent(app)
    const cancelled = await post(app, { intent: first, decision: "cancel" })
    expect(cancelled.status).toBe(200)
    // Replaying the still-VALIDATED copy after cancel: the store (not just
    // the status gate) rejects it — single-use holds end to end.
    const replayConfirm = await post(app, { intent: first, decision: "confirm" })
    expect(replayConfirm.status).toBe(422)
    const replayBody = (await replayConfirm.json()) as { code: string }
    expect(replayBody.code).toBe("DUPLICATE_INTENT")

    const second = await validatedIntent(app)
    const confirmed = await post(app, { intent: second, decision: "confirm" })
    expect(confirmed.status).toBe(200)
    const replayCancel = await post(app, { intent: second, decision: "cancel" })
    expect(replayCancel.status).toBe(422)
    const replayCancelBody = (await replayCancel.json()) as { code: string }
    expect(replayCancelBody.code).toBe("DUPLICATE_INTENT")
  })

  it("rejects decide-after-revalidate as DUPLICATE_INTENT (sticky terminals)", async () => {
    const app = createApp()
    const first = await validatedIntent(app)
    const confirmed = await post(app, { intent: first, decision: "confirm" })
    expect(confirmed.status).toBe(200)
    // Re-validating a decided intent refreshes nothing (record stays
    // CONFIRMED), so deciding the fresh copy is a duplicate, not a revival.
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    const reparsed = sealIntent(
      { ...base, intentId: first.intentId, status: "PARSED" as const },
      TEST_SEAL_SECRET
    )
    const revalidatedRes = await postValidate(app, reparsed)
    expect(revalidatedRes.status).toBe(200)
    const revalidated = (await revalidatedRes.json()) as {
      ok: boolean
      intent: PaymentIntentType
    }
    const again = await post(app, { intent: revalidated.intent, decision: "confirm" })
    expect(again.status).toBe(422)
    const againBody = (await again.json()) as { code: string }
    expect(againBody.code).toBe("DUPLICATE_INTENT")
  })

  it("rejects decisions for intents never validated here", async () => {
    const app = createApp()
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    const stranger = sealIntent(
      { ...base, status: "VALIDATED" as const },
      TEST_SEAL_SECRET
    )
    const res = await post(app, { intent: stranger, decision: "confirm" })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("NOT_VALIDATED")
  })

  it("catches expiry at confirmation time", async () => {
    const app = createApp()
    const stale = sealIntent(
      { ...(await validatedIntent(app)), expiry: "2020-01-01T00:00:00.000Z" },
      TEST_SEAL_SECRET
    )
    const res = await post(app, { intent: stale, decision: "confirm" })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("EXPIRED")
  })
})
