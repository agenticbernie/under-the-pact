import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Keypair, PublicKey, Transaction } from "@solana/web3.js"
import {
  createTransferCheckedInstruction,
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

const TEST_SEAL_SECRET = "test-seal-secret-000000000000000000000001"

process.env["MERCHANT_WALLET"] = "11111111111111111111111111111111"
process.env["MERCHANT_ACTIVE"] = "true"
process.env["INTENT_SEAL_SECRET"] = TEST_SEAL_SECRET

// Test-only ephemeral keys (never shipped): sign stub-built transactions.
const payer = Keypair.generate()
const SENDER = payer.publicKey.toBase58()

const stubReads = (overrides: Partial<SolanaReads> = {}): SolanaReads => ({
  getLatestBlockhash: async () =>
    "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  getAccount: async () => true,
  getMintDecimals: async () => 6,
  getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  getTransaction: async () => null,
  getSignatureStatuses: async () => [null],
  sendRawTransaction: async () => "SIG_test_11111111111111111111111111111111",
  ...overrides,
})

const postValidate = (app: ReturnType<typeof createApp>, intent: unknown) =>
  app.request("/api/intent/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent }),
  })

/** Sealed CONFIRMED intent recorded in the app's store. */
const confirmedIntent = async (
  app: ReturnType<typeof createApp>
): Promise<PaymentIntentType> => {
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  const parsed = sealIntent(
    { ...base, intentId: createIntentId(), status: "PARSED" as const },
    TEST_SEAL_SECRET
  )
  const validatedRes = await postValidate(app, parsed)
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

/** Unsigned build, then signed with the test-only ephemeral key. */
const signedFor = async (
  app: ReturnType<typeof createApp>,
  intent: PaymentIntentType,
  signer: typeof payer = payer
): Promise<string> => {
  const builtRes = await app.request("/api/tx/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent, sender: signer.publicKey.toBase58() }),
  })
  expect(builtRes.status).toBe(200)
  const built = (await builtRes.json()) as {
    ok: boolean
    transaction: { transaction: string }
  }
  const tx = Transaction.from(
    Buffer.from(built.transaction.transaction, "base64")
  )
  tx.partialSign(signer)
  return Buffer.from(tx.serialize()).toString("base64")
}

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/api/tx/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

/**
 * BER-142 plumbing: only sealed CONFIRMED snapshots with real signatures
 * submit; every outcome is recorded and reported honestly.
 */
describe("POST /api/tx/submit", () => {
  it("submits and captures the signature as pending (never success)", async () => {
    const app = createApp({ solanaReads: stubReads() })
    const intent = await confirmedIntent(app)
    const res = await post(app, {
      intent,
      signedTransaction: await signedFor(app, intent),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      attempt: {
        intentId: string
        signature: string
        status: string
        submittedAt: string
      }
    }
    expect(body.ok).toBe(true)
    expect(body.attempt.signature).toBe(
      "SIG_test_11111111111111111111111111111111"
    )
    expect(body.attempt.status).toBe("SUBMITTED")
    expect(body.attempt.intentId).toBe(intent.intentId)
    expect("verified" in body).toBe(false)
  })

  it("rejects malformed, unsigned, and unconfirmed payloads", async () => {
    const app = createApp({ solanaReads: stubReads() })
    expect((await post(app, "nope{{{")).status).toBe(400)
    expect((await post(app, {})).status).toBe(400)

    const intent = await confirmedIntent(app)
    // Unsigned build bytes are never broadcast.
    const builtRes = await app.request("/api/tx/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent, sender: SENDER }),
    })
    const built = (await builtRes.json()) as {
      transaction: { transaction: string }
    }
    const unsigned = await post(app, {
      intent,
      signedTransaction: built.transaction.transaction,
    })
    expect(unsigned.status).toBe(400)

    // PARSED was never confirmed: gate refuses.
    const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
    const parsedOnly = sealIntent(
      { ...base, intentId: createIntentId(), status: "PARSED" as const },
      TEST_SEAL_SECRET
    )
    const gated = await post(app, {
      intent: parsedOnly,
      signedTransaction: await signedFor(app, intent),
    })
    expect(gated.status).toBe(422)
  })

  it("rejects signed bytes that are not the authorized build (Qodo 1)", async () => {
    const app = createApp({ solanaReads: stubReads() })
    const intent = await confirmedIntent(app)
    // Real signature, wrong amount (1 micro vs 5M approved).
    const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
    const tx = new Transaction()
    tx.feePayer = payer.publicKey
    tx.recentBlockhash = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
    tx.add(
      createTransferCheckedInstruction(
        await getAssociatedTokenAddress(mint, payer.publicKey, false, TOKEN_PROGRAM_ID),
        mint,
        await getAssociatedTokenAddress(
          mint,
          new PublicKey("11111111111111111111111111111111"),
          false,
          TOKEN_PROGRAM_ID
        ),
        payer.publicKey,
        BigInt(1),
        6
      )
    )
    tx.partialSign(payer)
    const res = await post(app, {
      intent,
      signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("INVALID_REQUEST")
  })

  it("blocks duplicate submission of the same intent", async () => {
    const app = createApp({ solanaReads: stubReads() })
    const intent = await confirmedIntent(app)
    const signed = await signedFor(app, intent)
    const first = await post(app, { intent, signedTransaction: signed })
    expect(first.status).toBe(200)
    const second = await post(app, { intent, signedTransaction: signed })
    expect(second.status).toBe(422)
    const body = (await second.json()) as {
      code: string
      attempt?: { signature: string; status: string }
    }
    expect(body.code).toBe("DUPLICATE_INTENT")
    // The recorded attempt restores pending instead of claiming failure.
    expect(body.attempt?.signature).toBe(
      "SIG_test_11111111111111111111111111111111"
    )
    expect(body.attempt?.status).toBe("SUBMITTED")
  })

  it("records broadcast errors as INDETERMINATE with reconcile data", async () => {
    let fail = true
    const app = createApp({
      solanaReads: stubReads({
        sendRawTransaction: async () => {
          if (fail) {
            throw new Error("slot expired")
          }
          return "SIG_retry_ok"
        },
      }),
    })
    const intent = await confirmedIntent(app)
    const signed = await signedFor(app, intent)
    const failed = await post(app, { intent, signedTransaction: signed })
    expect(failed.status).toBe(500)
    const failedBody = (await failed.json()) as {
      ok: boolean
      code: string
      possibleSignature?: string
      attempt?: { status: string }
    }
    expect(failedBody.ok).toBe(false)
    expect(failedBody.code).toBe("SUBMISSION_INDETERMINATE")
    // The would-be signature lets the operator reconcile on the explorer.
    expect(typeof failedBody.possibleSignature).toBe("string")
    expect(failedBody.attempt?.status).toBe("INDETERMINATE")

    // No blind rebuild while indeterminate: same bytes are rejected so a
    // possibly-landed transaction can never double-send.
    fail = false
    const retry = await post(app, { intent, signedTransaction: signed })
    expect(retry.status).toBe(422)
    const retryBody = (await retry.json()) as {
      code: string
      possibleSignature?: string
    }
    expect(retryBody.code).toBe("DUPLICATE_INTENT")
    // The indeterminate attempt (with its would-be signature) is returned
    // for explorer reconciliation.
    expect(typeof retryBody.possibleSignature).toBe("string")
  })

  it("re-runs policy before reserving: deactivated merchant blocks submit (Codex P1)", async () => {
    const app = createApp({ solanaReads: stubReads() })
    const intent = await confirmedIntent(app)
    const signed = await signedFor(app, intent)
    process.env["MERCHANT_ACTIVE"] = "false"
    try {
      const res = await post(app, { intent, signedTransaction: signed })
      expect(res.status).toBe(422)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe("UNKNOWN_MERCHANT")
    } finally {
      process.env["MERCHANT_ACTIVE"] = "true"
    }
  })

  it("fails closed when the backend RPC serves the wrong cluster (Codex P2)", async () => {
    const app = createApp({
      solanaReads: stubReads({
        getGenesisHash: async () =>
          "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      }),
    })
    const intent = await confirmedIntent(app)
    // Handcraft the valid signed bytes directly: /tx/build itself enforces
    // the cluster guard, so the endpoint helper cannot produce them here.
    const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
    const tx = new Transaction()
    tx.feePayer = payer.publicKey
    tx.recentBlockhash = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
    tx.add(
      createTransferCheckedInstruction(
        await getAssociatedTokenAddress(mint, payer.publicKey, false, TOKEN_PROGRAM_ID),
        mint,
        await getAssociatedTokenAddress(
          mint,
          new PublicKey("11111111111111111111111111111111"),
          false,
          TOKEN_PROGRAM_ID
        ),
        payer.publicKey,
        BigInt(5_000_000),
        6
      )
    )
    tx.partialSign(payer)
    const res = await post(app, {
      intent,
      signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("INTERNAL_ERROR")
  })
})
