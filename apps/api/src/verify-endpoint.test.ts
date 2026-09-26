import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Keypair, PublicKey, Transaction } from "@solana/web3.js"
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import {
  PaymentIntent,
  createIntentId,
  validIntentFixture,
  type PaymentIntent as PaymentIntentType
} from "@pact/shared"
import { createApp } from "./app.js"
import { sealIntent } from "./intent/seal.js"
import type { SolanaReads } from "./solana/txbuilder.js"
import type { VersionedTransactionResponse } from "@solana/web3.js"

const TEST_SEAL_SECRET = "test-seal-secret-000000000000000000000001"
const DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const MERCHANT_WALLET = "11111111111111111111111111111111"
const SIG =
  "59TuJ5S315My8os456VYxib2MFVX9JTGB8VB78HXvQJX7qPJTkfMnhFi3gQ5EjmL4QffiKhiFLXYksxEuUCpcYhi"

// Test-only ephemeral keys (never shipped).
const payer = Keypair.generate()
const SENDER = payer.publicKey.toBase58()

process.env["MERCHANT_WALLET"] = MERCHANT_WALLET
process.env["MERCHANT_ACTIVE"] = "true"
process.env["INTENT_SEAL_SECRET"] = TEST_SEAL_SECRET

const stubReads = (overrides: Partial<SolanaReads> = {}): SolanaReads => ({
  getLatestBlockhash: async () =>
    "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  getAccount: async () => true,
  getMintDecimals: async () => 6,
  sendRawTransaction: async () => SIG,
  getGenesisHash: async () =>
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  getTransaction: async () => null,
  getSignatureStatuses: async () => [null],
  ...overrides,
})

const postJson = (
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown
) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

const fetchIntent = async (
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown
): Promise<PaymentIntentType> => {
  const res = await postJson(app, path, body)
  expect(res.status).toBe(200)
  const data = (await res.json()) as { ok: boolean; intent: PaymentIntentType }
  return data.intent
}

/** Full chain to a SUBMITTED intent, returning its live signature. */
const submittedIntent = async (
  app: ReturnType<typeof createApp>
): Promise<{ intent: PaymentIntentType; signature: string }> => {
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  const parsed = sealIntent(
    { ...base, intentId: createIntentId(), status: "PARSED" as const },
    TEST_SEAL_SECRET
  )
  const validated = await fetchIntent(app, "/api/intent/validate", {
    intent: parsed,
  })
  const confirmedRes = await postJson(app, "/api/intent/confirm", {
    intent: validated,
    decision: "confirm",
  })
  expect(confirmedRes.status).toBe(200)
  const confirmed = (await confirmedRes.json()) as {
    ok: boolean
    intent: PaymentIntentType
  }
  const builtRes = await postJson(app, "/api/tx/build", {
    intent: confirmed.intent,
    sender: SENDER,
  })
  expect(builtRes.status).toBe(200)
  const built = (await builtRes.json()) as {
    ok: boolean
    transaction: { transaction: string }
  }
  const tx = Transaction.from(
    Buffer.from(built.transaction.transaction, "base64")
  )
  tx.partialSign(payer)
  const signed = Buffer.from(tx.serialize()).toString("base64")
  const submittedRes = await postJson(app, "/api/tx/submit", {
    intent: confirmed.intent,
    signedTransaction: signed,
  })
  expect(submittedRes.status).toBe(200)
  return { intent: confirmed.intent, signature: SIG }
}

/** A stub receipt whose transfer matches the submitted test payment. */
const matchingReceipt = async () => {
  const senderAta = (
    await getAssociatedTokenAddress(
      new PublicKey(DEVNET_MINT),
      payer.publicKey,
      false,
      TOKEN_PROGRAM_ID
    )
  ).toBase58()
  const destAta = (
    await getAssociatedTokenAddress(
      new PublicKey(DEVNET_MINT),
      new PublicKey(MERCHANT_WALLET),
      false,
      TOKEN_PROGRAM_ID
    )
  ).toBase58()
  return {
    slot: 99,
    blockTime: 1780000000,
    meta: { err: null, fee: 5000 },
    transaction: {
      message: {
        accountKeys: [senderAta, DEVNET_MINT, destAta],
        instructions: [
          {
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: {
                source: senderAta,
                mint: DEVNET_MINT,
                destination: destAta,
                authority: SENDER,
                tokenAmount: { amount: "5000000", decimals: 6 },
              },
            },
          },
        ],
      },
      signatures: [SIG],
    },
  } as unknown as VersionedTransactionResponse
}

const appWithReceipt = (receipt: unknown) =>
  createApp({
    solanaReads: stubReads({
      getTransaction: async () =>
        receipt as unknown as VersionedTransactionResponse,
      getSignatureStatuses: async () => [{ confirmationStatus: "finalized" }],
    }),
  })

/**
 * BER-144 plumbing: VERIFIED only after every on-chain check passes;
 * everything else fails in-contract with stable reasons.
 */
describe("POST /api/tx/verify", () => {
  it("rejects malformed bodies with 400", async () => {
    const app = createApp({ solanaReads: stubReads() })
    expect((await postJson(app, "/api/tx/verify", "nope{{{")).status).toBe(400)
    expect((await postJson(app, "/api/tx/verify", {})).status).toBe(400)
  })

  it("refuses intents with no submission record in this instance", async () => {
    const setupApp = createApp({ solanaReads: stubReads() })
    const { intent } = await submittedIntent(setupApp)
    // Fresh app instance, isolated store: the submission record lives in
    // the other instance, so verification rightly refuses (NOT_VALIDATED).
    // Production shares one Postgres store (Sprint 3, BER-145).
    const app = createApp({
      solanaReads: stubReads({
        getTransaction: async () => matchingReceipt() as never,
        getSignatureStatuses: async () => [{ confirmationStatus: "finalized" }],
      }),
    })
    const re = await postJson(app, "/api/tx/verify", {
      intent,
      signature: SIG,
    })
    expect(re.status).toBe(422)
    const body = (await re.json()) as { code: string }
    expect(body.code).toBe("NOT_VALIDATED")
  })

  it("verifies end to end within one app instance", async () => {
    const receipt = await matchingReceipt()
    const app = createApp({
      solanaReads: stubReads({
        getTransaction: async () => receipt as never,
        getSignatureStatuses: async () => [{ confirmationStatus: "finalized" }],
      }),
    })
    const { intent } = await submittedIntent(app)
    const first = await postJson(app, "/api/tx/verify", {
      intent,
      signature: SIG,
    })
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as {
      ok: boolean
      verified: { intentId: string; signature: string; slot: number }
      intent: PaymentIntentType
    }
    expect(firstBody.ok).toBe(true)
    expect(firstBody.verified.intentId).toBe(intent.intentId)
    expect(firstBody.intent.status).toBe("VERIFIED")

    // Polling again is idempotent success, not a duplicate.
    const second = await postJson(app, "/api/tx/verify", {
      intent: firstBody.intent,
      signature: SIG,
    })
    expect(second.status).toBe(200)
  })

  it("rejects amount mismatch with VERIFICATION_FAILED", async () => {
    const receipt = await matchingReceipt()
    const receiptTx = (receipt as unknown as Record<string, Record<string, unknown>>)[
      "transaction"
    ] as Record<string, unknown>
    const wrong = {
      ...receipt,
      transaction: {
        ...receiptTx,
        message: {
          accountKeys: ["a", "b", "c"],
          instructions: [
            {
              program: "spl-token",
              parsed: {
                type: "transferChecked",
                info: {
                  source: "a",
                  mint: DEVNET_MINT,
                  destination: "c",
                  authority: SENDER,
                  tokenAmount: { amount: "1", decimals: 6 },
                },
              },
            },
          ],
        },
      },
    }
    const app = createApp({
      solanaReads: stubReads({
        getTransaction: async () => wrong as never,
        getSignatureStatuses: async () => [{ confirmationStatus: "finalized" }],
      }),
    })
    const { intent } = await submittedIntent(app)
    const res = await postJson(app, "/api/tx/verify", {
      intent,
      signature: SIG,
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("VERIFICATION_FAILED")
  })

  it("propagates missing and unresolved receipts", async () => {
    const app = createApp({ solanaReads: stubReads() })
    const { intent } = await submittedIntent(app)
    const missing = await postJson(app, "/api/tx/verify", {
      intent,
      signature: SIG,
    })
    expect(missing.status).toBe(404)

    const pendingApp = createApp({
      solanaReads: stubReads({
        getTransaction: async () => null,
        getSignatureStatuses: async () => [{ confirmationStatus: "processed" }],
      }),
    })
    const { intent: pendingIntent } = await submittedIntent(pendingApp)
    const pending = await postJson(pendingApp, "/api/tx/verify", {
      intent: pendingIntent,
      signature: SIG,
    })
    expect(pending.status).toBe(202)
    const pendingBody = (await pending.json()) as {
      code: string
      confirmationStatus: string
    }
    expect(pendingBody.code).toBe("TX_PENDING")
    expect(pendingBody.confirmationStatus).toBe("processed")
  })
})
