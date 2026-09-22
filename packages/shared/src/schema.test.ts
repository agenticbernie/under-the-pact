import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { MerchantConfig, PaymentIntent } from "./schema.js"

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
      recipientWallet: "REPLACE_WITH_DEVNET_RECIPIENT_WALLET",
      supportedTokenMint: "4zMMC9sEqf9MKyRbf3Tx3sQAr1BLWnCQcHjEXtGbm4o",
      network: "devnet",
      spendingLimitUsdc: 50,
      active: true
    })
    expect(decoded.network).toBe("devnet")
  })
})
