import { Data, Effect } from "effect"
import base58 from "bs58"
import type { VersionedTransactionResponse } from "@solana/web3.js"
import { PolicyErrorCode } from "@pact/shared"
import { PolicyError } from "../policy/engine.js"
import type { SolanaReads } from "./txbuilder.js"

/**
 * BER-143 / C-011 Transaction Receipt Fetcher: observation only.
 *
 * Turns a transaction signature into the parsed result the verifier
 * (BER-144) decides on. Outcomes:
 *  - Found: parsed tx + confirmation level + execution flag + extracted
 *    transfer details. A *failed* on-chain execution is data (executionErr
 *    set), returned normally.
 *  - Unresolved: the node knows the signature (processed status) but has
 *    no transaction yet, or the transaction arrived without metadata.
 *    Retryable — never success, never failure.
 *  - Missing: neither lookup has any record (never submitted, dropped,
 *    or pruned).
 *  - RPC failure: transport/endpoint error — a distinct typed failure, so
 *    callers never confuse "node is down" with "payment failed".
 * Missing, failed, or unresolved receipts can never become VERIFIED —
 * that gate lives in the verifier.
 */

export type ReceiptStatus = "confirmed" | "finalized" | "processed"

export type UnresolvedReason = "processed-only" | "metadata-unavailable"

export interface TransferDetails {
  authority: string
  sourceAta: string
  destinationAta: string
  mint: string
  amountMicro: number
  decimals: number
}

export interface FetchedReceipt {
  signature: string
  /** Best-known confirmation level ("processed" < "confirmed" < "finalized"). */
  status: ReceiptStatus
  slot: number
  blockTime: number | null
  /**
   * Null meta.err means on-chain success — and only then: a null meta
   * object itself yields Unresolved, never success (Qodo 2 + Codex P1).
   */
  executionErr: unknown
  /** Parsed transfer fields for deterministic verification (null when absent). */
  transfer: TransferDetails | null
  /** Raw parsed transaction for the verifier — uninterpreted here. */
  transaction: VersionedTransactionResponse
}

export type ReceiptOutcome =
  | { _tag: "Found"; receipt: FetchedReceipt }
  | { _tag: "Unresolved"; confirmationStatus: ReceiptStatus | null; reason: UnresolvedReason }
  | { _tag: "Missing" }

export class ReceiptError extends Data.TaggedError("ReceiptError")<{
  code:
    | typeof PolicyErrorCode.INTERNAL_ERROR
    | typeof PolicyErrorCode.INVALID_REQUEST
  message: string
}> {}

const fail = (
  code: ReceiptError["code"],
  message: string
): Effect.Effect<never, ReceiptError> =>
  Effect.fail(new ReceiptError({ code, message }))

const rank: Record<ReceiptStatus, number> = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
}

const asStatus = (value: unknown): ReceiptStatus | null =>
  value === "finalized" || value === "confirmed" || value === "processed"
    ? value
    : null

/** Ed25519 signatures are exactly 64 bytes — enforce before any RPC call. */
const isWellFormedSignature = (sig: string): boolean => {
  try {
    return base58.decode(sig).length === 64
  } catch {
    return false
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null

const asStringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : null

/**
 * Extract the first TransferChecked payment from parsed or compiled
 * instruction data. Returns null when no parseable payment exists —
 * the verifier (BER-144) treats that as unverifiable, never as success.
 */
export const extractTransfer = (tx: VersionedTransactionResponse): TransferDetails | null => {
  try {
    const message = asRecord(
      (tx as unknown as Record<string, unknown>)["transaction"]
    )
    const inner = asRecord(message?.["message"])
    const instructions = inner?.["instructions"]
    if (!Array.isArray(instructions)) {
      return null
    }
    const accountKeys = asStringArray(inner?.["accountKeys"]) ?? []
    for (const raw of instructions) {
      const ix = asRecord(raw)
      if (ix === null) {
        continue
      }
      // Parsed form (jsonParsed): { parsed: { type, info }, program, ... }.
      const parsed = asRecord(ix["parsed"])
      if (parsed !== null) {
        if (parsed["type"] !== "transferChecked") {
          continue
        }
        const info = asRecord(parsed["info"])
        const tokenAmount = asRecord(info?.["tokenAmount"])
        const source = info?.["source"]
        const destination = info?.["destination"]
        const mint = info?.["mint"]
        const authority = info?.["authority"]
        const amountRaw = tokenAmount?.["amount"]
        const decimalsRaw = tokenAmount?.["decimals"]
        if (
          typeof source !== "string" ||
          typeof destination !== "string" ||
          typeof mint !== "string" ||
          typeof authority !== "string"
        ) {
          continue
        }
        const amountMicro = Number(amountRaw)
        const decimals = Number(decimalsRaw)
        if (
          !Number.isSafeInteger(amountMicro) ||
          !Number.isInteger(decimals) ||
          decimals < 0 ||
          decimals > 9
        ) {
          continue
        }
        return {
          authority,
          sourceAta: source,
          destinationAta: destination,
          mint,
          amountMicro,
          decimals,
        }
      }
      // Compiled form: { programIdIndex, accounts[], data (base58) }.
      const dataRaw = ix["data"]
      const accountsRaw = ix["accounts"]
      if (typeof dataRaw !== "string" || !Array.isArray(accountsRaw)) {
        continue
      }
      let data: Uint8Array
      try {
        data = base58.decode(dataRaw)
      } catch {
        continue
      }
      // Exact ten-byte TransferChecked payload (cf. txbuilder gate).
      if (data.length !== 10 || data[0] !== 12) {
        continue
      }
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
      const amountMicro = Number(view.getBigUint64(1, true))
      const decimals = data[9]
      if (!Number.isSafeInteger(amountMicro)) {
        continue
      }
      const idx = accountsRaw as unknown[]
      if (
        idx.length < 4 ||
        typeof idx[0] !== "number" ||
        typeof idx[1] !== "number" ||
        typeof idx[2] !== "number" ||
        typeof idx[3] !== "number"
      ) {
        continue
      }
      const keys = [idx[0], idx[1], idx[2], idx[3]].map((i) => accountKeys[i as number])
      if (keys.some((k) => typeof k !== "string")) {
        continue
      }
      return {
        authority: keys[3] as string,
        sourceAta: keys[0] as string,
        destinationAta: keys[2] as string,
        mint: keys[1] as string,
        amountMicro,
        decimals,
      }
    }
    return null
  } catch {
    return null
  }
}

export const fetchReceipt = (
  signature: string,
  reads: SolanaReads
): Effect.Effect<ReceiptOutcome, ReceiptError> =>
  Effect.gen(function* () {
    const sig = signature.trim()
    if (!isWellFormedSignature(sig)) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Signature must be a base58 Ed25519 transaction signature (64 bytes)."
      )
    }
    const [tx, statuses] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          reads.getTransaction(sig),
          reads.getSignatureStatuses([sig]),
        ]),
      catch: (cause) =>
        new ReceiptError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: `Receipt RPC failed: ${String(cause).slice(0, 200)}`,
        }),
    })
    const reported = asStatus(statuses[0]?.confirmationStatus ?? null)
    if (tx === null || tx === undefined) {
      // Known-but-unconfirmed beats missing: a processed signature exists
      // even though the confirmed-commitment query has no transaction yet.
      if (reported !== null) {
        return {
          _tag: "Unresolved",
          confirmationStatus: reported,
          reason: "processed-only",
        } as const
      }
      return { _tag: "Missing" } as const
    }
    if (tx.meta === null || tx.meta === undefined) {
      // Metadata unavailable: outcome unknown — never success, never failure.
      return {
        _tag: "Unresolved",
        confirmationStatus: reported,
        reason: "metadata-unavailable",
      } as const
    }
    // Default to confirmed: getTransaction itself was read at confirmed
    // commitment, so the record exists at least at that level.
    const status: ReceiptStatus = reported ?? "confirmed"
    return {
      _tag: "Found",
      receipt: {
        signature: sig,
        status,
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        executionErr: tx.meta.err ?? null,
        transfer: extractTransfer(tx),
        transaction: tx,
      },
    } as const
  })

/** Highest confirmation level across receipts (demo polling helper). */
export const maxReceiptStatus = (
  statuses: ReceiptStatus[]
): ReceiptStatus | null => {
  let best: ReceiptStatus | null = null
  for (const s of statuses) {
    if (best === null || rank[s] > rank[best]) {
      best = s
    }
  }
  return best
}
