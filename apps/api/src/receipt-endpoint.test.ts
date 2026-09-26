import { describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import type { SolanaReads } from "./solana/txbuilder.js"

process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"
process.env["MERCHANT_ACTIVE"] = "true"
process.env["INTENT_SEAL_SECRET"] = "test-seal-secret-000000000000000000000001"

const SIG =
  "59TuJ5S315My8os456VYxib2MFVX9JTGB8VB78HXvQJX7qPJTkfMnhFi3gQ5EjmL4QffiKhiFLXYksxEuUCpcYhi"

const stubReads = (overrides: Partial<SolanaReads> = {}): SolanaReads => ({
  getLatestBlockhash: async () => "B",
  getAccount: async () => true,
  getMintDecimals: async () => 6,
  sendRawTransaction: async () => "SIG_x",
  getGenesisHash: async () =>
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  getTransaction: async () => null,
  getSignatureStatuses: async () => [null],
  ...overrides,
})

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/api/tx/receipt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

/**
 * BER-143 plumbing: malformed input never reaches RPC; missing, failed,
 * and RPC-error paths stay distinct for the verifier and demo UI.
 */
describe("POST /api/tx/receipt", () => {
  it("rejects malformed bodies with 400", async () => {
    const app = createApp({ solanaReads: stubReads() })
    expect((await post(app, "nope{{{")).status).toBe(400)
    expect((await post(app, {})).status).toBe(400)
    expect((await post(app, { signature: "  " })).status).toBe(400)
    expect((await post(app, { signature: "x" })).status).toBe(400)
  })

  it("returns 404 TX_NOT_FOUND for unknown signatures", async () => {
    const app = createApp({ solanaReads: stubReads() })
    const res = await post(app, { signature: SIG })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe("TX_NOT_FOUND")
  })

  it("returns parsed receipts with finality", async () => {
    const app = createApp({
      solanaReads: stubReads({
        getTransaction: async () =>
          ({
            slot: 99,
            blockTime: 1780000001,
            meta: { err: null, fee: 5000 },
            transaction: { message: {}, signatures: [SIG] },
          }) as never,
        getSignatureStatuses: async () => [{ confirmationStatus: "finalized" }],
      }),
    })
    const res = await post(app, { signature: SIG })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      receipt: { status: string; slot: number; executionErr: unknown }
    }
    expect(body.ok).toBe(true)
    expect(body.receipt.status).toBe("finalized")
    expect(body.receipt.executionErr).toBeNull()
  })

  it("maps RPC failure to 500, never to missing", async () => {
    const app = createApp({
      solanaReads: stubReads({
        getTransaction: async () => {
          throw new Error("node down")
        },
      }),
    })
    const res = await post(app, { signature: SIG })
    expect(res.status).toBe(500)
  })

  it("returns retryable 202 TX_PENDING for processed-only signatures", async () => {
    const app = createApp({
      solanaReads: stubReads({
        getTransaction: async () => null,
        getSignatureStatuses: async () => [{ confirmationStatus: "processed" }],
      }),
    })
    const res = await post(app, { signature: SIG })
    expect(res.status).toBe(202)
    const body = (await res.json()) as {
      ok: boolean
      code: string
      confirmationStatus: string
    }
    expect(body.ok).toBe(false)
    expect(body.code).toBe("TX_PENDING")
    expect(body.confirmationStatus).toBe("processed")
  })

  it("fails closed when the backend RPC serves the wrong cluster", async () => {
    const app = createApp({
      solanaReads: stubReads({
        getGenesisHash: async () =>
          "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      }),
    })
    const res = await post(app, { signature: SIG })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("INTERNAL_ERROR")
  })
})
