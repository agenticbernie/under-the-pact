import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  PaymentIntent,
  validIntentFixture,
  type PaymentIntent as PaymentIntentType
} from "@pact/shared"
import { createApp } from "./app.js"
import { sealIntent } from "./intent/seal.js"

const TEST_SEAL_SECRET = "test-seal-secret-000000000000000000000001"

process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"
// Fail-closed default is inactive: tests pin explicit activation.
process.env["MERCHANT_ACTIVE"] = "true"
process.env["INTENT_SEAL_SECRET"] = TEST_SEAL_SECRET

const parsedIntent = (): PaymentIntentType => {
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  const parsed = { ...base, status: "PARSED" as const }
  return sealIntent(parsed, TEST_SEAL_SECRET)
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
      // Re-seal after patching: seal covers the new values, policy rejects.
      const tampered = sealIntent(
        { ...parsedIntent(), ...patch } as PaymentIntentType,
        TEST_SEAL_SECRET
      )
      const res = await post(app, { intent: tampered })
      expect(res.status).toBe(422)
      const body = (await res.json()) as { ok: boolean; code: string }
      expect(body.ok).toBe(false)
      expect(body.code).toBe(code)
    }
  })

  it("rejects forged intents at the seal with 400, before policy (Qodo)", async () => {
    const app = createApp()
    // Amount flipped, old seal kept: schema-valid but untrusted.
    const forged = { ...parsedIntent(), amountMicroUsdc: 1 }
    const res = await post(app, { intent: forged })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe("INVALID_REQUEST")

    // Unsealed intents are rejected too.
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    const unsealed = await post(app, {
      intent: { ...base, status: "PARSED" }
    })
    expect(unsealed.status).toBe(400)
  })

  it("maps a missing seal secret to 500 INTERNAL_ERROR", async () => {
    delete process.env["INTENT_SEAL_SECRET"]
    const app = createApp()
    const res = await post(app, { intent: parsedIntent() })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.code).toBe("INTERNAL_ERROR")
    process.env["INTENT_SEAL_SECRET"] = TEST_SEAL_SECRET
  })

  it("maps a misconfigured limit to logged 500, not 422 (Qodo)", async () => {
    process.env["SPENDING_LIMIT_USDC"] = "0"
    const app = createApp()
    // Sealed under the test secret; policy must hit the limit config first.
    const res = await post(app, { intent: parsedIntent() })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.code).toBe("INTERNAL_ERROR")
    delete process.env["SPENDING_LIMIT_USDC"]
  })
})
