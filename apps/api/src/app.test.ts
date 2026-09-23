import { beforeEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { LlmClient } from "./intent/llm.js"
import { createApp } from "./app.js"

// MERCHANT_WALLET is required (no placeholder default). Tests pin a
// valid-format dummy (system program address) — replace with a real
// devnet wallet via .env for local runs.
// MERCHANT_ACTIVE defaults to inactive (fail-closed): tests pin it on.
process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"
process.env["MERCHANT_ACTIVE"] = "true"

/** Stubbed LLM boundary: no network, deterministic model JSON. */
const stubLlm = (reply: string) =>
  // Test double: plain object cast to the service brand (runtime shape matches).
  Layer.succeed(
    LlmClient,
    { completeJson: () => Effect.succeed(reply) } as unknown as LlmClient
  )

const goodExtraction = JSON.stringify({
  merchantReference: "Pact Coffee",
  amountUsdc: "5",
  tokenMention: "USDC",
  purpose: "oat latte"
})

describe("api skeleton (BER-129)", () => {
  it("GET /api/health returns ok + network", async () => {
    const app = createApp()
    const res = await app.request("/api/health")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; network: string }
    expect(body.ok).toBe(true)
    expect(typeof body.network).toBe("string")
  })

  it("POST /api/intent/parse rejects empty / blank / oversize text with 400", async () => {
    const app = createApp()
    for (const text of ["", "   \n  ", "x".repeat(2001)]) {
      const res = await app.request("/api/intent/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { ok: boolean; code: string }
      expect(body.ok).toBe(false)
      expect(body.code).toBe("INVALID_REQUEST")
    }
  })

  it("POST /api/intent/parse rejects non-JSON and missing text with 400", async () => {
    const app = createApp()
    const notJson = await app.request("/api/intent/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{"
    })
    expect(notJson.status).toBe(400)
    const missing = await app.request("/api/intent/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    })
    expect(missing.status).toBe(400)
  })

  it("POST /api/intent/parse rejects JSON null with 400, not 500 (Codex P2)", async () => {
    const app = createApp()
    const res = await app.request("/api/intent/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null"
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe("INVALID_REQUEST")
  })

  it("GET /api/merchant exposes the single registered merchant", async () => {
    const app = createApp()
    const res = await app.request("/api/merchant")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      merchant: {
        merchantId: string
        recipientWallet: string
        network: string
        token: string
        spendingLimitUsdc: number
        active: boolean
      }
    }
    expect(body.ok).toBe(true)
    expect(body.merchant.merchantId).toBe("pact-coffee-demo")
    expect(body.merchant.token).toBe("USDC")
    expect(body.merchant.active).toBe(true)
  })

  it("POST /api/intent/parse returns a PARSED intent for good model output", async () => {
    const app = createApp({ llmLayer: stubLlm(goodExtraction) })
    const res = await app.request("/api/intent/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "  Pay 5 USDC to Pact Coffee  " })
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      intent: { status: string; amountMicroUsdc: number; merchantId: string }
    }
    expect(body.ok).toBe(true)
    expect(body.intent.status).toBe("PARSED")
    expect(body.intent.amountMicroUsdc).toBe(5_000_000)
    expect(body.intent.merchantId).toBe("pact-coffee-demo")
  })

  it("POST /api/intent/parse returns recoverable clarification (422, not policy)", async () => {
    const app = createApp({
      llmLayer: stubLlm(
        JSON.stringify({
          merchantReference: "Pact Coffee",
          amountUsdc: null,
          tokenMention: null,
          purpose: null
        })
      )
    })
    const res = await app.request("/api/intent/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Pay Pact Coffee" })
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as {
      ok: boolean
      code: string
      missing: string[]
    }
    expect(body.ok).toBe(false)
    expect(body.code).toBe("AMBIGUOUS_REQUEST")
    expect(body.missing).toContain("amount")
  })

  it("POST /api/intent/parse maps unconfigured LLM to 500 PARSER_ERROR", async () => {
    delete process.env["LLM_API_KEY"]
    const app = createApp()
    const res = await app.request("/api/intent/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Pay 5 USDC to Pact Coffee" })
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.code).toBe("PARSER_ERROR")
  })

  it("POST /api/intent/parse rejects bad INTENT_TTL_SECONDS in-contract (Codex P2)", async () => {
    for (const ttl of ["0", "-5", "not-a-number", "99999999"]) {
      process.env["INTENT_TTL_SECONDS"] = ttl
      const app = createApp({ llmLayer: stubLlm(goodExtraction) })
      const res = await app.request("/api/intent/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Pay 5 USDC to Pact Coffee" })
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; code: string }
      expect(body.ok).toBe(false)
      expect(body.code).toBe("PARSER_ERROR")
    }
    delete process.env["INTENT_TTL_SECONDS"]
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
