import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  invalidIntentFixtures,
  PaymentIntent,
  validIntentFixture
} from "@pact/shared"

/**
 * BER-131: the backend consumes the exact canonical schema + fixtures.
 * Parser (BER-132), policy engine (BER-134/135) and execution layers
 * decode through this same boundary — AI/client output is untrusted
 * until it passes here.
 */
describe("intent schema consumption (BER-131)", () => {
  it("decodes the canonical valid fixture", () => {
    const decoded = Schema.decodeUnknownSync(PaymentIntent)(
      validIntentFixture()
    )
    expect(decoded.token).toBe("USDC")
  })

  it("rejects every canonical invalid fixture", () => {
    for (const f of invalidIntentFixtures()) {
      expect(
        () => Schema.decodeUnknownSync(PaymentIntent)(f.data),
        `fixture ${f.name} should fail`
      ).toThrow()
    }
  })
})
