import { Data, Effect } from "effect"
import type { VersionedTransactionResponse } from "@solana/web3.js"
import { PolicyErrorCode } from "@pact/shared"
import { PolicyError } from "../policy/engine.js"
import type { SolanaReads } from "./txbuilder.js"

/**
 * BER-143 / C-011 Transaction Receipt Fetcher: observation only.
 *
 * Turns a transaction signature into the raw parsed result the verifier
 * (BER-144) decides on. Outcomes:
 *  - confirmed/finalized/processed: parsed tx + status (success flag inside
 *    meta.err — a *failed* on-chain execution is data, returned normally).
 *  - missing: the node has no record (never submitted, dropped, or pruned).
 *  - RPC failure: transport/endpoint error — a distinct typed failure, so
 *    callers never confuse "node is down" with "payment failed".
 * Missing, failed, or unresolved receipts can never become VERIFIED —
 * that gate lives in the verifier.
 */

export type ReceiptStatus = "confirmed" | "finalized" | "processed"

export interface FetchedReceipt {
  signature: string
  /** Best-known confirmation level ("processed" < "confirmed" < "finalized"). */
  status: ReceiptStatus
  slot: number
  blockTime: number | null
  /** Null meta.err means on-chain success; non-null describes the failure. */
  executionErr: unknown
  /** Raw parsed transaction for the verifier — uninterpreted here. */
  transaction: VersionedTransactionResponse
}

export type ReceiptOutcome =
  | { _tag: "Found"; receipt: FetchedReceipt }
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

export const fetchReceipt = (
  signature: string,
  reads: SolanaReads
): Effect.Effect<ReceiptOutcome, ReceiptError> =>
  Effect.gen(function* () {
    if (signature.trim().length < 32 || signature.trim().length > 128) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Signature must be a base58 transaction signature."
      )
    }
    const sig = signature.trim()
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
    if (tx === null || tx === undefined) {
      return { _tag: "Missing" } as const
    }
    const reported = statuses[0]?.confirmationStatus ?? null
    // Default to confirmed: getTransaction itself was read at confirmed
    // commitment, so the record exists at least at that level.
    const status: ReceiptStatus =
      reported === "finalized" || reported === "confirmed" || reported === "processed"
        ? reported
        : "confirmed"
    return {
      _tag: "Found",
      receipt: {
        signature: sig,
        status,
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        executionErr: tx.meta?.err ?? null,
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
