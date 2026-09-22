import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  MAX_REQUEST_CHARS,
  MerchantConfig,
  normalizeRequestText,
  PaymentIntent,
  PaymentRequest
} from "./schema.js"

// System program address: valid base58, decodes to 32 bytes. Test-only dummy.
const DUMMY_WALLET = "11111111111111111111111111111111"
const DEVNET_USDC_MINT = "4zMMC9sEqf9MKyRbf3Tx3sQAr1BLWnCQcHjEXtGbm4o"

describe("shared schema skeleton (BER-129)", () => {
  it("decodes a minimal intent skeleton", () => {
    const decoded = Schema.decodeUnknownSync(PaymentIntent)({
      intentId: "intent_test_001",
      status: "DRAFT"
    })
    expect(decoded.intentId).toBe("intent_test_001")
  })

  it("decodes merchant config from env-shaped input", () => {
    const decoded = Schema.decodeUnknownSync(MerchantConfig)({
      merchantId: "pact-coffee-demo",
      displayName: "Pact Coffee Demo",
      recipientWallet: DUMMY_WALLET,
      supportedTokenMint: DEVNET_USDC_MINT,
      network: "devnet",
      spendingLimitUsdc: 50,
      active: true
    })
    expect(decoded.network).toBe("devnet")
  })

  it("rejects a non-pubkey recipient wallet", () => {
    expect(() =>
      Schema.decodeUnknownSync(MerchantConfig)({
        merchantId: "pact-coffee-demo",
        displayName: "Pact Coffee Demo",
        recipientWallet: "REPLACE_WITH_DEVNET_RECIPIENT_WALLET",
        supportedTokenMint: DEVNET_USDC_MINT,
        network: "devnet",
        spendingLimitUsdc: 50,
        active: true
      })
    ).toThrow()
  })
})

describe("payment request input (BER-130)", () => {
  it("accepts a normal request", () => {
    const decoded = Schema.decodeUnknownSync(PaymentRequest)({
      text: "Pay 5 USDC to Pact Coffee for oat latte"
    })
    expect(decoded.text).toContain("USDC")
  })

  it("rejects empty and blank input", () => {
    expect(() => Schema.decodeUnknownSync(PaymentRequest)({ text: "" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(PaymentRequest)({ text: "   \n\t  " })
    ).toThrow()
  })

  it(`rejects input over ${MAX_REQUEST_CHARS} chars`, () => {
    expect(() =>
      Schema.decodeUnknownSync(PaymentRequest)({ text: "x".repeat(MAX_REQUEST_CHARS + 1) })
    ).toThrow()
  })

  it("normalizes surrounding whitespace", () => {
    expect(normalizeRequestText("  pay 5 usdc  \n")).toBe("pay 5 usdc")
  })
})
