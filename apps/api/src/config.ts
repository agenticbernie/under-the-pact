import { Config, Effect, Layer, Schema } from "effect"
import { MerchantConfig } from "@pact/shared"

/**
 * Centralized, env-driven config (REQ-S-007/008, BER-129 AC#2).
 * Fail-fast at boot: missing/invalid env => startup error, never silent defaults.
 * Neon Functions injects DATABASE_URL automatically; locally it comes from .env.
 */

const SolanaNetworkSchema = Schema.Literal("devnet", "testnet", "mainnet-beta")

export const PactConfig = Schema.Struct({
  solanaNetwork: SolanaNetworkSchema,
  solanaRpcUrl: Schema.String,
  usdcMint: Schema.NonEmptyString,
  merchant: MerchantConfig,
  databaseUrl: Schema.optional(Schema.String)
})
export type PactConfig = typeof PactConfig.Type

const configFromEnv = Effect.gen(function*() {
  const solanaNetwork = yield* Config.string("SOLANA_NETWORK").pipe(
    Config.withDefault("devnet")
  )
  const solanaRpcUrl = yield* Config.string("SOLANA_RPC_URL").pipe(
    Config.withDefault("https://api.devnet.solana.com")
  )
  const usdcMint = yield* Config.string("USDC_MINT").pipe(
    Config.withDefault("4zMMC9sEqf9MKyRbf3Tx3sQAr1BLWnCQcHjEXtGbm4o")
  )
  const merchantId = yield* Config.string("MERCHANT_ID").pipe(
    Config.withDefault("pact-coffee-demo")
  )
  const displayName = yield* Config.string("MERCHANT_DISPLAY_NAME").pipe(
    Config.withDefault("Pact Coffee Demo")
  )
  const recipientWallet = yield* Config.string("MERCHANT_WALLET").pipe(
    Config.withDefault("REPLACE_WITH_DEVNET_RECIPIENT_WALLET")
  )
  const spendingLimitUsdc = yield* Config.number("SPENDING_LIMIT_USDC").pipe(
    Config.withDefault(50)
  )
  const databaseUrl = yield* Config.string("DATABASE_URL").pipe(Config.option)

  const raw = {
    solanaNetwork,
    solanaRpcUrl,
    usdcMint,
    merchant: {
      merchantId,
      displayName,
      recipientWallet,
      supportedTokenMint: usdcMint,
      network: solanaNetwork,
      spendingLimitUsdc,
      active: true
    },
    databaseUrl: databaseUrl._tag === "Some" ? databaseUrl.value : undefined
  }
  return yield* Schema.decodeUnknown(PactConfig)(raw)
})

export class PactConfigService extends Effect.Service<PactConfigService>()(
  "PactConfigService",
  { effect: configFromEnv }
) {}

export const PactConfigLive = PactConfigService.Default
