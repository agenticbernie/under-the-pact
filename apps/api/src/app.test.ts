import { beforeEach, describe, expect, it } from "vitest"
import { createApp } from "./app.js"

// MERCHANT_WALLET is required (no placeholder default). Tests pin a
// valid-format dummy (system program address) — replace with a real
// devnet wallet via .env for local runs.
process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"

describe("api skeleton (BER-129)", () => {
  it("GET /api/health returns ok + network", async () => {
    const app = createApp()
    const res = await app.request("/api/health")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; network: string }
    expect(body.ok).toBe(true)
    expect(typeof body.network).toBe("string")
  })

  it("POST /api/intent/parse is 501 until BER-132", async () => {
    const app = createApp()
    const res = await app.request("/api/intent/parse", { method: "POST" })
    expect(res.status).toBe(501)
  })
})

describe("config network defaults (Codex P1)", () => {
  const OLD_ENV = { ...process.env }
  beforeEach(() => {
    process.env = { ...OLD_ENV }
  })

  it("devnet keeps devnet RPC + mint", async () => {
    const { PactConfigLive, PactConfigService } = await import("./config.js")
    const { Effect } = await import("effect")
    process.env["SOLANA_NETWORK"] = "devnet"
    process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"
    delete process.env["SOLANA_RPC_URL"]
    delete process.env["USDC_MINT"]
    const mint = await Effect.runPromise(
      Effect.gen(function* () {
        const cfg = yield* PactConfigService
        return cfg.usdcMint
      }).pipe(Effect.provide(PactConfigLive))
    )
    expect(mint).toBe("4zMMC9sEqf9MKyRbf3Tx3sQAr1BLWnCQcHjEXtGbm4o")
  })

  it("mainnet-beta never inherits the devnet mint", async () => {
    const { PactConfigLive, PactConfigService } = await import("./config.js")
    const { Effect } = await import("effect")
    process.env["SOLANA_NETWORK"] = "mainnet-beta"
    process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"
    delete process.env["USDC_MINT"]
    const mint = await Effect.runPromise(
      Effect.gen(function* () {
        const cfg = yield* PactConfigService
        return cfg.usdcMint
      }).pipe(Effect.provide(PactConfigLive))
    )
    expect(mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
  })
})
