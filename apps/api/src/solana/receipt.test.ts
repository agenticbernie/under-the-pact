import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { VersionedTransactionResponse } from "@solana/web3.js"
import {
  extractTransfer,
  fetchReceipt,
  maxReceiptStatus,
} from "./receipt.js"
import type { SolanaReads } from "./txbuilder.js"

const fakeTx = (err: unknown): VersionedTransactionResponse =>
  ({
    slot: 424242,
    blockTime: 1780000000,
    meta: { err, fee: 5000, preBalances: [1], postBalances: [1] },
    transaction: { message: {}, signatures: ["SIG_x"] },
  }) as unknown as VersionedTransactionResponse

const stubReads = (overrides: Partial<SolanaReads> = {}): SolanaReads => ({
  getLatestBlockhash: async () => "B",
  getAccount: async () => true,
  getMintDecimals: async () => 6,
  sendRawTransaction: async () => "SIG_x",
  getGenesisHash: async () =>
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  getTransaction: async () => fakeTx(null),
  getSignatureStatuses: async () => [{ confirmationStatus: "finalized" }],
  ...overrides,
})

const SIG =
  "59TuJ5S315My8os456VYxib2MFVX9JTGB8VB78HXvQJX7qPJTkfMnhFi3gQ5EjmL4QffiKhiFLXYksxEuUCpcYhi"

const run = (signature: string, reads: SolanaReads = stubReads()) =>
  Effect.runPromiseExit(fetchReceipt(signature, reads))

describe("receipt fetcher (BER-143)", () => {
  it("returns parsed data with finality for a successful tx", async () => {
    const exit = await run(SIG)
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success" || exit.value._tag !== "Found") {
      throw new Error("expected Found")
    }
    const r = exit.value.receipt
    expect(r.signature).toBe(SIG)
    expect(r.status).toBe("finalized")
    expect(r.slot).toBe(424242)
    expect(r.executionErr).toBeNull()
  })

  it("returns on-chain failures as data, not as RPC errors", async () => {
    const exit = await run(
      SIG,
      stubReads({
        getTransaction: async () => fakeTx({ InstructionError: [0, "Custom"] }),
        getSignatureStatuses: async () => [{ confirmationStatus: "confirmed" }],
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success" || exit.value._tag !== "Found") {
      throw new Error("expected Found")
    }
    expect(exit.value.receipt.executionErr).toEqual({
      InstructionError: [0, "Custom"],
    })
  })

  it("reports missing transactions distinctly", async () => {
    const exit = await run(
      SIG,
      stubReads({
        getTransaction: async () => null,
        getSignatureStatuses: async () => [null],
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") {
      throw new Error("expected outcome")
    }
    expect(exit.value._tag).toBe("Missing")
  })

  it("preserves processed-only signatures as Unresolved, not Missing", async () => {
    const exit = await run(
      SIG,
      stubReads({
        getTransaction: async () => null,
        getSignatureStatuses: async () => [{ confirmationStatus: "processed" }],
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") {
      throw new Error("expected outcome")
    }
    expect(exit.value._tag).toBe("Unresolved")
    if (exit.value._tag === "Unresolved") {
      expect(exit.value.confirmationStatus).toBe("processed")
      expect(exit.value.reason).toBe("processed-only")
    }
  })

  it("treats null metadata as Unresolved, never success", async () => {
    const exit = await run(
      SIG,
      stubReads({
        getTransaction: async () =>
          ({
            slot: 7,
            blockTime: null,
            meta: null,
            transaction: { message: {}, signatures: [SIG] },
          }) as unknown as VersionedTransactionResponse,
        getSignatureStatuses: async () => [{ confirmationStatus: "confirmed" }],
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") {
      throw new Error("expected outcome")
    }
    expect(exit.value._tag).toBe("Unresolved")
    if (exit.value._tag === "Unresolved") {
      expect(exit.value.reason).toBe("metadata-unavailable")
    }
  })

  it("maps RPC transport failure to a typed error, not a receipt", async () => {
    const exit = await run(
      SIG,
      stubReads({
        getTransaction: async () => {
          throw new Error("node down")
        },
      })
    )
    expect(exit._tag).toBe("Failure")
  })

  it("rejects malformed signatures before any RPC call", async () => {
    let called = false
    const exit = await run(
      "x",
      stubReads({
        getTransaction: async () => {
          called = true
          return fakeTx(null)
        },
      })
    )
    expect(exit._tag).toBe("Failure")
    expect(called).toBe(false)
  })

  it("rejects length-valid non-base58 and wrong-size signatures", async () => {
    for (const bad of [
      "_".repeat(64),
      "11111111111111111111111111111111", // valid base58, 32 bytes, not 64
    ]) {
      let called = false
      const exit = await run(
        bad,
        stubReads({
          getTransaction: async () => {
            called = true
            return fakeTx(null)
          },
        })
      )
      expect(exit._tag, bad).toBe("Failure")
      expect(called, bad).toBe(false)
    }
  })

  it("extracts parsed transferChecked payment fields", async () => {
    const tx = {
      slot: 1,
      blockTime: null,
      meta: { err: null },
      transaction: {
        message: {
          accountKeys: ["SRC_ATA", "MINT_X", "DST_ATA"],
          instructions: [
            {
              program: "spl-token",
              parsed: {
                type: "transferChecked",
                info: {
                  source: "SRC_ATA",
                  mint: "MINT_X",
                  destination: "DST_ATA",
                  authority: "AUTH_Y",
                  tokenAmount: { amount: "5000000", decimals: 6 },
                },
              },
            },
          ],
        },
        signatures: ["SIG"],
      },
    } as unknown as VersionedTransactionResponse
    expect(extractTransfer(tx)).toEqual({
      authority: "AUTH_Y",
      sourceAta: "SRC_ATA",
      destinationAta: "DST_ATA",
      mint: "MINT_X",
      amountMicro: 5_000_000,
      decimals: 6,
    })
  })

  it("returns null transfer for non-payment transactions", async () => {
    const tx = {
      slot: 1,
      blockTime: null,
      meta: { err: null },
      transaction: { message: { accountKeys: [], instructions: [] }, signatures: [] },
    } as unknown as VersionedTransactionResponse
    expect(extractTransfer(tx)).toBeNull()
    expect(extractTransfer(null as never)).toBeNull()
  })

  it("ranks confirmation levels", () => {
    expect(maxReceiptStatus(["processed", "confirmed", "finalized"])).toBe(
      "finalized"
    )
    expect(maxReceiptStatus([])).toBeNull()
  })
})
