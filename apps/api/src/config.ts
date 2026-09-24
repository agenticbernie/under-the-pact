import { Config, Effect, Schema } from "effect"
import {
  decimalUsdcToMicro,
  MerchantConfig,
  SolanaNetwork
} from "@pact/shared"

/**
 * Centralized, env-driven config (REQ-S-007/008, BER-129 AC#2).
 * Fail-fast at boot: missing/invalid env => startup error, never silent defaults.
 * Neon Functions injects DATABASE_URL automatically; locally it comes from .env.
 */

const SolanaNetworkSchema = SolanaNetwork

export const PactConfig = Schema.Struct({
  solanaNetwork: SolanaNetworkSchema,
  solanaRpcUrl: Schema.String,
  usdcMint: Schema.String,
  merchant: MerchantConfig,
  databaseUrl: Schema.optional(Schema.String)
})
export type PactConfig = typeof PactConfig.Type

/**
 * Per-network safe defaults (Codex P1: no cross-network silent reuse).
 * testnet has NO known USDC mint placeholder — omitting USDC_MINT there
 * is a boot error, never a silent devnet value.
 */
const NETWORK_DEFAULTS: Record<
  SolanaNetwork,
  { rpcUrl: string; usdcMint: string | undefined }
> = {
  devnet: {
    rpcUrl: "https://api.devnet.solana.com",
    usdcMint: "4zMMC9sEqf9MKyRbf3Tx3sQAr1BLWnCQcHjEXtGbm4o"
  },
  testnet: {
    rpcUrl: "https://api.testnet.solana.com",
    usdcMint: undefined
  },
  "mainnet-beta": {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  }
}

const configFromEnv = Effect.gen(function*() {
  const rawNetwork = yield* Config.string("SOLANA_NETWORK").pipe(
    Config.withDefault("devnet")
  )
  const solanaNetwork = yield* Schema.decodeUnknown(SolanaNetworkSchema)(
    rawNetwork
  )
  const defaults = NETWORK_DEFAULTS[solanaNetwork]

  const solanaRpcUrl = yield* Config.string("SOLANA_RPC_URL").pipe(
    Config.withDefault(defaults.rpcUrl)
  )

  let usdcMint: string
  if (defaults.usdcMint !== undefined) {
    usdcMint = yield* Config.string("USDC_MINT").pipe(
      Config.withDefault(defaults.usdcMint)
    )
  } else {
    // No safe default for this network — require explicit value.
    usdcMint = yield* Config.string("USDC_MINT")
  }

  const merchantId = yield* Config.string("MERCHANT_ID").pipe(
    Config.withDefault("pact-coffee-demo")
  )
  const displayName = yield* Config.string("MERCHANT_DISPLAY_NAME").pipe(
    Config.withDefault("Pact Coffee Demo")
  )
  // Required + pubkey-validated by MerchantConfig schema below.
  // No placeholder default: a missing/invalid wallet must fail boot,
  // never report healthy (Codex P2). Use a real devnet wallet or, for
  // local skeleton runs only, the system program address from .env.example.
  const recipientWallet = yield* Config.string("MERCHANT_WALLET")
  const spendingLimitUsdc = yield* Config.number("SPENDING_LIMIT_USDC").pipe(
    Config.withDefault(50)
  )
  // Fail-fast (Qodo PR #7): a non-positive or unrepresentable limit must
  // break config load — never surface later as a per-request 422 that
  // looks like user error. The engine keeps its defensive check.
  if (
    !Number.isFinite(spendingLimitUsdc) ||
    decimalUsdcToMicro(String(spendingLimitUsdc)) === null ||
    (decimalUsdcToMicro(String(spendingLimitUsdc)) as number) <= 0
  ) {
    return yield* Effect.fail(
      new Error(
        "SPENDING_LIMIT_USDC must be a positive decimal with at most 6 decimals."
      )
    )
  }
  // Kill-switch (BER-133): only an explicit truthy value activates the
  // merchant — including when the variable is OMITTED entirely (Codex P1:
  // an absent deployment setting must never silently enable payments).
  // Policy (BER-134) rejects intents for inactive merchants.
  const activeRaw = yield* Config.string("MERCHANT_ACTIVE").pipe(
    Config.withDefault("")
  )
  const active = /^(true|1|yes)$/i.test(activeRaw.trim())
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
      active
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
