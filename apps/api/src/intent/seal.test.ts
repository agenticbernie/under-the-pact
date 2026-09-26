import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  PaymentIntent,
  validIntentFixture,
  type PaymentIntent as PaymentIntentType
} from "@pact/shared"
import { sealIntent, verifyIntentSeal } from "./seal.js"

const SECRET = "test-seal-secret-000000000000000000000001"
const OTHER_SECRET = "test-seal-secret-000000000000000000000002"

const parsed = (): PaymentIntentType => {
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  return { ...base, status: "PARSED" as const }
}

describe("intent seal (Qodo PR #7)", () => {
  it("round-trips a sealed intent", () => {
    const sealed = sealIntent(parsed(), SECRET)
    expect(typeof sealed.seal).toBe("string")
    expect(verifyIntentSeal(sealed, SECRET)).toBe(true)
    // Sealed output still decodes through the canonical schema.
    expect(() =>
      Schema.decodeUnknownSync(PaymentIntent)(sealed)
    ).not.toThrow()
  })

  it("detects tampered amount, expiry, status, and recipient", () => {
    const sealed = sealIntent(parsed(), SECRET)
    const patches: Array<Partial<PaymentIntentType>> = [
      { amountMicroUsdc: 1 },
      { expiry: "2031-01-01T00:15:00.000Z" },
      { status: "VALIDATED" },
      { recipient: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }
    ]
    for (const patch of patches) {
      expect(
        verifyIntentSeal({ ...sealed, ...patch }, SECRET),
        JSON.stringify(patch)
      ).toBe(false)
    }
  })

  it("rejects missing seals and wrong secrets", () => {
    const intent = parsed()
    expect(verifyIntentSeal(intent, SECRET)).toBe(false)
    expect(
      verifyIntentSeal({ ...intent, seal: "not-hex!!" }, SECRET)
    ).toBe(false)
    expect(verifyIntentSeal(sealIntent(intent, SECRET), OTHER_SECRET)).toBe(
      false
    )
  })
})
