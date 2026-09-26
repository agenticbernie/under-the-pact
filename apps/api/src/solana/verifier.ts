import { Data, Effect } from "effect"
import { PublicKey } from "@solana/web3.js"
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import {
  PolicyErrorCode,
  type MerchantConfig,
  type PaymentIntent,
} from "@pact/shared"
import { PolicyError } from "../policy/engine.js"
import type { FetchedReceipt } from "./receipt.js"

/**
 * BER-144 / C-012 Payment Verifier: deterministic intent matching.
 *
 * Compares blockchain data (from a fetched receipt) against the approved
 * intent, field by field: on-chain success, parseable transfer, sender,
 * recipient ATA, USDC mint, exact amount, precision. Every check must
 * pass — any mismatch yields VERIFICATION_FAILED with a stable `mismatch`
 * reason. VERIFIED is reachable only here, never from frontend state.
 *
 * Pure function of (intent, receipt, merchant): no RPC, no wallet,
 * independently testable. Clock/network come from the caller.
 */

export type VerificationMismatch =
  | "execution-failed"
  | "unparseable-transfer"
  | "sender"
  | "recipient"
  | "mint"
  | "amount"
  | "network"

export interface VerificationSuccess {
  intentId: string
  signature: string
  slot: number
  confirmations: string
}

const fail = (
  mismatch: VerificationMismatch,
  message: string
): Effect.Effect<never, PolicyError> =>
  Effect.fail(
    new PolicyError({
      code: PolicyErrorCode.VERIFICATION_FAILED,
      message: `${mismatch}: ${message}`,
    })
  )

export const verifyPayment = (
  intent: PaymentIntent,
  receipt: FetchedReceipt,
  merchant: MerchantConfig
): Effect.Effect<VerificationSuccess, PolicyError> =>
  Effect.gen(function* () {
    // 1. On-chain execution must have succeeded.
    if (receipt.executionErr !== null && receipt.executionErr !== undefined) {
      return yield* fail(
        "execution-failed",
        "On-chain execution failed — the transfer did not happen."
      )
    }
    // 2. A parseable USDC transfer must exist.
    const t = receipt.transfer
    if (t === null) {
      return yield* fail(
        "unparseable-transfer",
        "No parseable USDC transfer in this transaction."
      )
    }
    // 3. Network: the approved network must equal the merchant network.
    // (The RPC cluster itself is guarded by the caller via assertRpcCluster.)
    if (intent.network !== merchant.network) {
      return yield* fail(
        "network",
        `Intent network ${intent.network} differs from merchant network ${merchant.network}.`
      )
    }
    // 4. Sender: bound wallet when set; otherwise any valid signer is
    // accepted (the wallet UI showed the user exactly this transaction).
    if (intent.userWallet !== undefined && t.authority !== intent.userWallet) {
      return yield* fail(
        "sender",
        "Transfer authority is not the wallet bound to this intent."
      )
    }
    // 5. Mint: exact configured USDC mint.
    if (t.mint !== intent.tokenMint || t.mint !== merchant.supportedTokenMint) {
      return yield* fail(
        "mint",
        "Transfer mint is not the configured USDC mint."
      )
    }
    // 6. Amount + precision: exact integer micro-USDC at six decimals.
    if (t.amountMicro !== intent.amountMicroUsdc || t.decimals !== 6) {
      return yield* fail(
        "amount",
        "Transfer amount differs from the approved amount."
      )
    }
    // 7. Recipient: destination must be the merchant's ATA for this mint.
    const expectedAta = yield* Effect.tryPromise({
      try: async () =>
        (
          await getAssociatedTokenAddress(
            new PublicKey(intent.tokenMint),
            new PublicKey(intent.recipient),
            false,
            TOKEN_PROGRAM_ID
          )
        ).toBase58(),
      catch: () =>
        new PolicyError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: "Could not derive the expected recipient account.",
        }),
    })
    if (t.destinationAta !== expectedAta) {
      return yield* fail(
        "recipient",
        "Transfer destination is not the registered merchant account."
      )
    }
    return {
      intentId: intent.intentId,
      signature: receipt.signature,
      slot: receipt.slot,
      confirmations: receipt.status,
    }
  })
