import { describe, expect, it } from "vitest"
import { Cause, Effect } from "effect"
import { Keypair, Transaction } from "@solana/web3.js"
import {
  createAttemptId,
  createMemoryAttemptLog,
  submitSignedTransaction,
} from "./submit.js"
import type { SolanaReads } from "./txbuilder.js"

// Test-only ephemeral keys (never shipped): build one signed payload.
const signedPayload = (): string => {
  const kp = Keypair.generate()
  const tx = new Transaction()
  tx.feePayer = kp.publicKey
  tx.recentBlockhash = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
  tx.add({ keys: [], programId: kp.publicKey, data: Buffer.from([0]) })
  tx.partialSign(kp)
  return Buffer.from(tx.serialize()).toString("base64")
}

const unsignedPayload = (): string => {
  const kp = Keypair.generate()
  const tx = new Transaction()
  tx.feePayer = kp.publicKey
  tx.recentBlockhash = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
  tx.add({ keys: [], programId: kp.publicKey, data: Buffer.from([0]) })
  return Buffer.from(
    tx.serialize({ requireAllSignatures: false })
  ).toString("base64")
}

const stubReads = (overrides: Partial<SolanaReads> = {}): SolanaReads => ({
  getLatestBlockhash: async () => "B",
  getAccount: async () => true,
  getMintDecimals: async () => 6,
  getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  getTransaction: async () => null,
  getSignatureStatuses: async () => [null],
  sendRawTransaction: async () => "SIG_live_11111111111111111111111111111111",
  ...overrides,
})

const codeOf = async (signedTransaction: string, reads: SolanaReads = stubReads()) => {
  const exit = await Effect.runPromiseExit(
    submitSignedTransaction({ signedTransaction, reads, network: "devnet" })
  )
  if (exit._tag === "Success") {
    return "OK"
  }
  const opt = Cause.failureOption(exit.cause)
  if (opt._tag === "None") {
    throw new Error("expected typed failure")
  }
  return (opt.value as { code: string }).code
}

describe("submission service (BER-142)", () => {
  it("broadcasts signed bytes and returns the network signature", async () => {
    const sent: string[] = []
    const exit = await Effect.runPromiseExit(
      submitSignedTransaction({
        signedTransaction: signedPayload(),
        network: "devnet",
        reads: stubReads({
          sendRawTransaction: async (bytes: Uint8Array) => {
            sent.push(Buffer.from(bytes).toString("base64"))
            return "SIG_live_abc"
          },
        }),
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.signature).toBe("SIG_live_abc")
    }
    expect(sent).toHaveLength(1)
  })

  it("refuses unsigned, undecodable, and non-base64 payloads", async () => {
    expect(await codeOf(unsignedPayload())).toBe("INVALID_REQUEST")
    expect(await codeOf("not-base64!!!")).toBe("INVALID_REQUEST")
    expect(await codeOf("e30=")).toBe("INVALID_REQUEST") // "{}" is valid base64+JSON, not a tx
  })

  it("maps broadcast failure to INTERNAL_ERROR, never success", async () => {
    expect(
      await codeOf(
        signedPayload(),
        stubReads({
          sendRawTransaction: async () => {
            throw new Error("slot expired")
          },
        })
      )
    ).toBe("INTERNAL_ERROR")
  })
})

describe("attempt log + ids", () => {
  it("records attempts per intent in order", () => {
    const log = createMemoryAttemptLog()
    expect(log.list("intent_a")).toEqual([])
    const t = new Date().toISOString()
    log.record({
      attemptId: "attempt_1",
      intentId: "intent_a",
      transactionSignature: "SIG_x",
      status: "SUBMITTED",
      submittedAt: t,
      failureReason: null,
    })
    log.record({
      attemptId: "attempt_2",
      intentId: "intent_a",
      transactionSignature: null,
      status: "FAILED",
      submittedAt: t,
      failureReason: "slot expired",
    })
    expect(log.list("intent_a").map((a) => a.attemptId)).toEqual([
      "attempt_1",
      "attempt_2",
    ])
    expect(createAttemptId()).toMatch(/^attempt_[0-9a-f]{32}$/)
  })
})

describe("backend cluster guard (Codex P1 PR #14)", () => {
  it("blocks broadcast on the wrong cluster without touching the network", async () => {
    let called = false
    const exit = await Effect.runPromiseExit(
      submitSignedTransaction({
        signedTransaction:
          "e30=" /* decodable check happens after cluster guard */,
        network: "devnet",
        reads: stubReads({
          getGenesisHash: async () =>
            "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
          sendRawTransaction: async () => {
            called = true
            return "SIG_x"
          },
        }),
      })
    )
    expect(exit._tag).toBe("Failure")
    expect(called).toBe(false)
  })
})
