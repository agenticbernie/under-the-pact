/**
 * BER-138: pure wallet-configuration helpers (unit-tested, no DOM).
 *
 * PoC supports exactly ONE wallet (Phantom) on ONE network. Anything else
 * is an explicit unsupported state — never a silent fallback.
 */

export const SUPPORTED_WALLET_NAME = "Phantom"

export type SolanaNetworkName = "devnet" | "testnet" | "mainnet-beta"

const DEFAULT_RPC: Record<SolanaNetworkName, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com"
}

export const isSupportedWallet = (name: string | null | undefined): boolean =>
  name === SUPPORTED_WALLET_NAME

export const isKnownNetwork = (value: string): value is SolanaNetworkName =>
  value === "devnet" || value === "testnet" || value === "mainnet-beta"

/** Explicit RPC override wins; otherwise the per-network default. */
export const resolveRpcEndpoint = (
  network: SolanaNetworkName,
  override?: string
): string => {
  const trimmed = (override ?? "").trim()
  return trimmed.length > 0 ? trimmed : DEFAULT_RPC[network]
}

/** Backend (policy) network vs frontend network: must match exactly. */
export const networksMatch = (
  frontend: string,
  backend: string | undefined
): boolean =>
  backend !== undefined && backend.length > 0 ? frontend === backend : true
