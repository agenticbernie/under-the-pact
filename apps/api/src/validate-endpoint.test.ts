import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  PaymentIntent,
  validIntentFixture,
  type PaymentIntent as PaymentIntentType
} from "@pact/shared"
import { createApp } from "./app.js"

process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"
// Fail-closed default is inactive: tests pin explicit activation.
process.env["MERCHANT_ACTIVE"] = "true"

const parsedIntent = (): PaymentIntentType => {
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  return { ...base, status: "PARSED" as const }
}

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/api/intent/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

/**
 * BER-134 + BER-135 plumbing: malformed bodies never reach the engine,
 * engine verdicts surface with their stable codes.
 */
describe("POST /api/intent/validate", () => {
  it("rejects non-JSON and non-intent bodies with 400", async () => {
    const app = createApp()
    const notJson = await post(app, "nope{{{")
    expect(notJson.status).toBe(400)
    const missing = await post(app, {})
    expect(missing.status).toBe(400)
    const wrongShape = await post(app, {
      intent: { intentId: "intent_nope" }
    })
    expect(wrongShape.status).toBe(400)
    const wrongBody = (await wrongShape.json()) as { code: string }
    expect(wrongBody.code).toBe("INVALID_REQUEST")
  })

  it("returns the VALIDATED intent for good input", async () => {
    const app = createApp()
    const res = await post(app, { intent: parsedIntent() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      intent: { status: string; amountMicroUsdc: number }
    }
    expect(body.ok).toBe(true)
    expect(body.intent.status).toBe("VALIDATED")
    expect(body.intent.amountMicroUsdc).toBe(5_000_000)
  })

  it("surfaces UNKNOWN_MERCHANT / OVER_LIMIT / EXPIRED codes", async () => {
    const app = createApp()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ merchantId: "starbucks" }, "UNKNOWN_MERCHANT"],
      [{ amountMicroUsdc: 51_000_000 }, "OVER_LIMIT"],
      [{ expiry: "2020-01-01T00:00:00.000Z" }, "EXPIRED"],
      [{ recipient: "4zMMC9sEqf9MKyRbf3Tx3sQAr1BLWnCQcHjEXtGbm4o" }, "RECIPIENT_MISMATCH"]
    ]
    for (const [patch, code] of cases) {
      const res = await post(app, {
        intent: { ...parsedIntent(), ...patch }
      })
      expect(res.status).toBe(422)
      const body = (await res.json()) as { ok: boolean; code: string }
      expect(body.ok).toBe(false)
      expect(body.code).toBe(code)
    }
  })
})
