import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { Transaction } from "@solana/web3.js"
import { PolicyErrorCode, type SolanaNetwork } from "@pact/shared"
import { PolicyError } from "../policy/engine.js"
import { assertRpcCluster, type SolanaReads } from "./txbuilder.js"

/**
 * BER-142 / C-010 Transaction Submission Service.
 *
 * Broadcasts the USER-SIGNED transaction and captures its signature.
 * This module never signs (no signer imports) and never verifies success:
 * a signature proves submission only — Sprint 3 (BER-143/144) verifies
 * on-chain. Submission failure is recorded and returned as failure,
 * never reported as success.
 *
 * Attempts are recorded in-process (AttemptLog, same adapter story as the
 * lifecycle store: memory now, Postgres in Sprint 3). A failed broadcast
 * records a FAILED attempt and leaves the intent CONFIRMED for retry;
 * a success consumes CONFIRMED -> SUBMITTED exactly once (DUPLICATE_INTENT
 * on replay), so the same intent can never submit twice.
 */

export interface PaymentAttempt {
  attemptId: string
  intentId: string
  transactionSignature: string | null
  /** INDETERMINATE: broadcast errored after possibly reaching the network. */
  status: "SUBMITTED" | "FAILED" | "INDETERMINATE"
  submittedAt: string
  failureReason: string | null
}

export interface AttemptLogApi {
  record(attempt: PaymentAttempt): void
  list(intentId: string): PaymentAttempt[]
}

export const createMemoryAttemptLog = (): AttemptLogApi => {
  const attempts = new Map<string, PaymentAttempt[]>()
  return {
    record: (attempt) => {
      const list = attempts.get(attempt.intentId) ?? []
      list.push(attempt)
      attempts.set(attempt.intentId, list)
    },
    list: (intentId) => [...(attempts.get(intentId) ?? [])],
  }
}

export class AttemptLog extends Context.Tag("AttemptLog")<
  AttemptLog,
  AttemptLogApi
>() {}

/** Fresh isolated attempt log: per app instance (tests) / isolate (prod). */
export const attemptMemoryLayer = (): Layer.Layer<AttemptLog> =>
  Layer.succeed(AttemptLog, createMemoryAttemptLog())

export const createAttemptId = (): string =>
  `attempt_${randomUUID().replace(/-/g, "")}`

export interface SubmitInput {
  /** Base64 user-signed transaction (must carry ≥1 signature). */
  signedTransaction: string
  reads: SolanaReads
  /** Intent network the backend RPC must serve (genesis-checked). */
  network: SolanaNetwork
}

export const submitSignedTransaction = (
  input: SubmitInput
): Effect.Effect<{ signature: string }, PolicyError> =>
  Effect.gen(function* () {
    // Backend cluster guard runs before any broadcast (Codex P1 PR #14).
    yield* assertRpcCluster(input.reads, input.network)
    // Decodable + actually signed: unsigned payloads are rejected here,
    // never broadcast.
    const raw = yield* Effect.try({
      try: () => Buffer.from(input.signedTransaction, "base64"),
      catch: () =>
        new PolicyError({
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Signed transaction is not valid base64.",
        }),
    })
    const tx = yield* Effect.try({
      try: () => Transaction.from(raw),
      catch: () =>
        new PolicyError({
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Signed transaction is not decodable.",
        }),
    })
    const present = tx.signatures.filter((s) => s.signature !== null)
    if (present.length === 0) {
      return yield* Effect.fail(
        new PolicyError({
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Transaction carries no signature — refusing to submit unsigned bytes.",
        })
      )
    }
    const signature = yield* Effect.tryPromise({
      try: () => input.reads.sendRawTransaction(raw),
      catch: (cause) =>
        new PolicyError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: `Submission failed: ${String(cause).slice(0, 200)}`,
        }),
    })
    return { signature }
  })
