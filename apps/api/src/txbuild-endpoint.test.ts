import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  PaymentIntent,
  createIntentId,
  validIntentFixture,
  type PaymentIntent as PaymentIntentType
} from "@pact/shared"
import { createApp } from "./app.js"
import { sealIntent } from "./intent/seal.js"
import type { SolanaReads } from "./solana/txbuilder.js"

const TEST_SEAL_SECRET = "test-seal-secret-000000000000000000000001"
const SENDER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const BLOCKHASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"

process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"
process.env["MERCHANT_ACTIVE"] = "true"
process.env["INTENT_SEAL_SECRET"] = TEST_SEAL_SECRET

const stubReads: SolanaReads = {
  getLatestBlockhash: async () => BLOCKHASH,
  getAccount: async () => true,
  getMintDecimals: async () => 6,
  getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  sendRawTransaction: async () => "SIG_test_11111111111111111111111111111111",
}

/** Full chain through the endpoints: parse-shape > validate > confirm. */
const confirmedIntent = async (
  app: ReturnType<typeof createApp>
): Promise<PaymentIntentType> => {
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  const parsed = sealIntent(
    { ...base, intentId: createIntentId(), status: "PARSED" as const },
    TEST_SEAL_SECRET
  )
  const validatedRes = await app.request("/api/intent/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent: parsed }),
  })
  expect(validatedRes.status).toBe(200)
  const validated = (await validatedRes.json()) as {
    ok: boolean
    intent: PaymentIntentType
  }
  const confirmedRes = await app.request("/api/intent/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent: validated.intent, decision: "confirm" }),
  })
  expect(confirmedRes.status).toBe(200)
  const confirmed = (await confirmedRes.json()) as {
    ok: boolean
    intent: PaymentIntentType
  }
  return confirmed.intent
}

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/api/tx/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

/**
 * BER-140 plumbing: only sealed CONFIRMED snapshots build, and the
 * response is an unsigned, inspectable transaction.
 */
describe("POST /api/tx/build", () => {
  it("builds an unsigned transaction for a CONFIRMED intent", async () => {
    const app = createApp({ solanaReads: stubReads })
    const res = await post(app, {
      intent: await confirmedIntent(app),
      sender: SENDER,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      transaction: {
        intentId: string
        transaction: string
        sender: string
        recipientAta: string
        mint: string
        amountMicroUsdc: number
        blockhash: string
      }
    }
    expect(body.ok).toBe(true)
    expect(body.transaction.sender).toBe(SENDER)
    expect(body.transaction.amountMicroUsdc).toBe(5_000_000)
    expect(body.transaction.blockhash).toBe(BLOCKHASH)
    expect(typeof body.transaction.transaction).toBe("string")
  })

  it("rejects non-JSON, non-intent, and missing-sender bodies with 400", async () => {
    const app = createApp({ solanaReads: stubReads })
    expect((await post(app, "nope{{{")).status).toBe(400)
    expect((await post(app, {})).status).toBe(400)
    const noSender = await post(app, {
      intent: await confirmedIntent(app),
    })
    expect(noSender.status).toBe(400)
  })

  it("rejects unconfirmed and forged intents before building", async () => {
    const app = createApp({ solanaReads: stubReads })
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    const parsedOnly = sealIntent(
      { ...base, intentId: createIntentId(), status: "PARSED" as const },
      TEST_SEAL_SECRET
    )
    // PARSED was never validated/recorded: gate refuses.
    const gated = await post(app, { intent: parsedOnly, sender: SENDER })
    expect(gated.status).toBe(422)

    const good = await confirmedIntent(app)
    const forged = await post(app, {
      intent: { ...good, amountMicroUsdc: 1 },
      sender: SENDER,
    })
    expect(forged.status).toBe(400)
  })

  it("fails explicit when the merchant ATA is missing", async () => {
    const app = createApp({
      solanaReads: { ...stubReads, getAccount: async () => false },
    })
    const res = await post(app, {
      intent: await confirmedIntent(app),
      sender: SENDER,
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("MERCHANT_ATA_MISSING")
  })
})
