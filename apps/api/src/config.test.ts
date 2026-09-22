import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { PactConfigLive, PactConfigService } from "./config.js"

const loadMerchantWallet = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cfg = yield* PactConfigService
      return cfg.merchant.recipientWallet
    }).pipe(Effect.provide(PactConfigLive))
  )

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<unknown>) => {
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  try {
    return await fn()
  } finally {
    process.env = saved
  }
}

describe("config fail-fast (Codex P2)", () => {
  it("rejects a placeholder recipient wallet", async () => {
    await expect(
      withEnv(
        {
          SOLANA_NETWORK: "devnet",
          MERCHANT_WALLET: "REPLACE_WITH_DEVNET_RECIPIENT_WALLET"
        },
        loadMerchantWallet
      )
    ).rejects.toThrow()
  })

  it("rejects a missing MERCHANT_WALLET", async () => {
    await expect(
      withEnv(
        { SOLANA_NETWORK: "devnet", MERCHANT_WALLET: undefined },
        loadMerchantWallet
      )
    ).rejects.toThrow()
  })

  it("requires explicit USDC_MINT on testnet (no devnet fallback)", async () => {
    await expect(
      withEnv(
        {
          SOLANA_NETWORK: "testnet",
          MERCHANT_WALLET: "11111111111111111111111111111111",
          USDC_MINT: undefined
        },
        loadMerchantWallet
      )
    ).rejects.toThrow()
  })
})
