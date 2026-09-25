import { describe, expect, it } from "vitest"
import {
  isKnownNetwork,
  isSupportedWallet,
  networksMatch,
  resolveRpcEndpoint,
  SUPPORTED_WALLET_NAME
} from "./wallet.js"

describe("wallet config (BER-138)", () => {
  it("supports exactly Phantom", () => {
    expect(SUPPORTED_WALLET_NAME).toBe("Phantom")
    expect(isSupportedWallet("Phantom")).toBe(true)
    expect(isSupportedWallet("Solflare")).toBe(false)
    expect(isSupportedWallet(null)).toBe(false)
    expect(isSupportedWallet(undefined)).toBe(false)
  })

  it("recognizes known networks only", () => {
    expect(isKnownNetwork("devnet")).toBe(true)
    expect(isKnownNetwork("mainnet-beta")).toBe(true)
    expect(isKnownNetwork("mainnet")).toBe(false)
    expect(isKnownNetwork("")).toBe(false)
  })

  it("resolves RPC with override winning over defaults", () => {
    expect(resolveRpcEndpoint("devnet")).toBe("https://api.devnet.solana.com")
    expect(resolveRpcEndpoint("devnet", "https://custom.rpc")).toBe("https://custom.rpc")
    expect(resolveRpcEndpoint("devnet", "  ")).toBe("https://api.devnet.solana.com")
  })

  it("flags frontend/backend network mismatch", () => {
    expect(networksMatch("devnet", "devnet")).toBe(true)
    expect(networksMatch("devnet", "mainnet-beta")).toBe(false)
    // Backend unreachable: don't block the wallet UI on it.
    expect(networksMatch("devnet", undefined)).toBe(true)
    expect(networksMatch("devnet", "")).toBe(true)
  })
})
