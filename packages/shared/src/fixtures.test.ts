import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  createIntentId,
  formatMicroUsdc,
  isExpired,
  MICRO_USDC_PER_USDC,
  PaymentIntent
} from "./schema.js"
import {
  invalidIntentFixtures,
  minimalValidIntentFixture,
  validIntentFixture
} from "./fixtures.js"

describe("payment intent fixtures (BER-131)", () => {
  it("decodes the full valid fixture", () => {
    const decoded = Schema.decodeUnknownSync(PaymentIntent)(
      validIntentFixture()
    )
    expect(decoded.merchantId).toBe("pact-coffee-demo")
    expect(decoded.amountMicroUsdc).toBe(5 * MICRO_USDC_PER_USDC)
  })

  it("decodes the minimal fixture without optional fields", () => {
    const decoded = Schema.decodeUnknownSync(PaymentIntent)(
      minimalValidIntentFixture()
    )
    expect(decoded.purpose).toBeUndefined()
    expect(decoded.userWallet).toBeUndefined()
  })

  it("rejects every invalid fixture", () => {
    const fixtures = invalidIntentFixtures()
    expect(fixtures.length).toBeGreaterThan(10)
    for (const f of fixtures) {
      expect(
        () => Schema.decodeUnknownSync(PaymentIntent)(f.data),
        `fixture ${f.name} (${f.why}) should fail`
      ).toThrow()
    }
  })
})

describe("intent helpers (pure, no UI/LLM)", () => {
  it("createIntentId matches the schema pattern", () => {
    for (let i = 0; i < 5; i++) {
      const id = createIntentId()
      expect(id).toMatch(/^intent_[A-Za-z0-9]{8,64}$/)
    }
    const ids = new Set(Array.from({ length: 20 }, createIntentId))
    expect(ids.size).toBe(20)
  })

  it("formatMicroUsdc renders without floats", () => {
    expect(formatMicroUsdc(5_000_000)).toBe("5")
    expect(formatMicroUsdc(5_500_000)).toBe("5.5")
    expect(formatMicroUsdc(1)).toBe("0.000001")
    expect(formatMicroUsdc(0)).toBe("0")
  })

  it("isExpired compares expiry against now", () => {
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    expect(isExpired(base, new Date("2029-12-31T23:59:59Z"))).toBe(false)
    expect(isExpired(base, new Date("2030-01-01T00:15:00.001Z"))).toBe(true)
  })
})
