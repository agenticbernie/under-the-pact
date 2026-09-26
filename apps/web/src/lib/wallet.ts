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

/**
 * Genesis hashes identify the actual Solana cluster behind an RPC URL
 * (Qodo PR #10: a PUBLIC_SOLANA_RPC_URL override may point elsewhere).
 * Values from the Solana/Agave sources — each cluster differs, so the
 * check fully distinguishes devnet/testnet/mainnet-beta. A mainnet
 * override means real-money risk and must block the wallet UI.
 * NOTE: intentionally duplicated (not imported) from @pact/shared to
 * keep the browser bundle free of effect/bs58 — both copies are pinned
 * by unit tests; keep them in sync.
 */
export const GENESIS_HASHES: Record<SolanaNetworkName, string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
}

export const genesisMatchesNetwork = (
  network: SolanaNetworkName,
  genesisHash: string
): boolean => GENESIS_HASHES[network] === genesisHash.trim()

export type NetworkVerification =
  | { state: "loading" }
  | { state: "verified"; backendNetwork: string }
  | { state: "error" }
