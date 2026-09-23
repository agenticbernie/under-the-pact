import { describe, expect, it } from "vitest"
import { Effect, Option } from "effect"
import { PactConfigLive } from "../config.js"
import { MerchantRegistryLive, MerchantRegistry } from "./registry.js"

process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"

const useRegistry = <A>(fn: (r: MerchantRegistry) => A): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* MerchantRegistry
      return fn(registry)
    }).pipe(
      Effect.provide(MerchantRegistryLive),
      Effect.provide(PactConfigLive)
    )
  )

describe("merchant registry (BER-133)", () => {
  it("exposes exactly the configured merchant, fully explicit", async () => {
    const merchant = await useRegistry((r) => r.getMerchant())
    expect(merchant.merchantId).toBe(
      process.env["MERCHANT_ID"] ?? "pact-coffee-demo"
    )
    expect(merchant.network).toBe(process.env["SOLANA_NETWORK"] ?? "devnet")
    expect(merchant.recipientWallet).toBe(
      "11111111111111111111111111111111"
    )
    expect(merchant.supportedTokenMint).toBe(
      process.env["USDC_MINT"] ??
        "4zMMC9sEqf9MKyRbf3Tx3sQAr1BLWnCQcHjEXtGbm4o"
    )
    expect(merchant.spendingLimitUsdc).toBe(50)
  })

  it("finds only the registered id", async () => {
    const found = await useRegistry((r) =>
      r.findMerchant("pact-coffee-demo")
    )
    expect(Option.isSome(found)).toBe(true)
    const missing = await useRegistry((r) => r.findMerchant("starbucks"))
    expect(Option.isNone(missing)).toBe(true)
  })

  it("resolveRecipient takes no address and always returns the merchant wallet", async () => {
    // Structural: the function signature accepts zero arguments, so no
    // caller can inject an arbitrary recipient through this module.
    const recipient = await useRegistry((r) => r.resolveRecipient())
    expect(recipient).toBe("11111111111111111111111111111111")
  })

  it("is inactive when MERCHANT_ACTIVE is not explicitly truthy", async () => {
    process.env["MERCHANT_ACTIVE"] = "typo-means-off"
    const active = await useRegistry((r) => r.isActive())
    expect(active).toBe(false)
    const found = await useRegistry((r) =>
      r.findMerchant("pact-coffee-demo")
    )
    expect(Option.isNone(found)).toBe(true)
    delete process.env["MERCHANT_ACTIVE"]
  })
})
