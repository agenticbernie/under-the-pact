import { Effect } from "effect"
import {
  Connection,
  PublicKey,
  Transaction,
  type AccountInfo,
} from "@solana/web3.js"
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import {
  PolicyErrorCode,
  type MerchantConfig,
} from "@pact/shared"
import { PolicyError } from "../policy/engine.js"
import type { ConfirmedIntent } from "../intent/confirm.js"

/**
 * BER-140 / C-009 USDC Transaction Builder.
 *
 * Deterministic construction ONLY: sealed CONFIRMED intent + sender +
 * merchant config + chain reads -> unsigned transaction. This module can
 * never sign or broadcast — no signer is imported or consulted, and the
 * response carries no signatures (empty signatures array by construction).
 *
 * Every execution-critical field derives from the sealed CONFIRMED intent
 * and merchant configuration: mint, sender ATA, merchant ATA, micro amount.
 * The merchant ATA must already exist (pre-created before the demo);
 * a missing one fails explicit instead of silently charging rent.
 * Sender ATA existence is preflight's job (BER-139), not duplicated here.
 */

export interface SolanaReads {
  getLatestBlockhash(): Promise<string>
  getAccount(publicKey: string): Promise<boolean>
  getMintDecimals(mint: string): Promise<number>
}

export const liveSolanaReads = (rpcUrl: string): SolanaReads => {
  const connection = new Connection(rpcUrl, "confirmed")
  return {
    getLatestBlockhash: () =>
      connection.getLatestBlockhash("confirmed").then((b) => b.blockhash),
    getAccount: (publicKey: string) =>
      connection
        .getAccountInfo(new PublicKey(publicKey))
        .then((info: AccountInfo<Buffer> | null) => info !== null),
    // getTokenSupply (not parsed methods): works on limited public RPCs,
    // and returns decimals directly.
    getMintDecimals: (mint: string) =>
      connection.getTokenSupply(new PublicKey(mint)).then((supply) => {
        const decimals = supply.value.decimals
        if (typeof decimals !== "number") {
          throw new Error("mint decimals unreadable")
        }
        return decimals
      }),
  }
}

export interface BuildInput {
  /** Already gated (sealed CONFIRMED, policy re-run) by the caller. */
  intent: ConfirmedIntent
  /** Connected wallet public key (base58). */
  sender: string
  merchant: MerchantConfig
  rpcUrl: string
  reads?: SolanaReads
}

export interface BuiltTransaction {
  intentId: string
  /** Base64 unsigned legacy transaction (no signatures attached). */
  transaction: string
  sender: string
  senderAta: string
  recipientAta: string
  mint: string
  amountMicroUsdc: number
  decimals: number
  blockhash: string
}

const fail = (
  code: PolicyError["code"],
  message: string
): Effect.Effect<never, PolicyError> =>
  Effect.fail(new PolicyError({ code, message }))

const asPubkey = (
  value: string,
  code: PolicyError["code"],
  message: string
): Effect.Effect<PublicKey, PolicyError> =>
  Effect.try({
    try: () => new PublicKey(value),
    catch: () => new PolicyError({ code, message }),
  })

export const buildUsdcTransfer = (
  input: BuildInput
): Effect.Effect<BuiltTransaction, PolicyError> =>
  Effect.gen(function* () {
    const reads = input.reads ?? liveSolanaReads(input.rpcUrl)
    const { intent, merchant } = input

    // Sender: valid pubkey, and must equal the bound wallet when the
    // intent carries one (wallet bound at parse; mismatch = wrong signer).
    const sender = yield* asPubkey(
      input.sender,
      PolicyErrorCode.INVALID_REQUEST,
      "Sender must be a valid Solana wallet address."
    )
    if (
      intent.userWallet !== undefined &&
      intent.userWallet !== sender.toBase58()
    ) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Sender does not match the wallet bound to this intent."
      )
    }

    const mint = yield* asPubkey(
      intent.tokenMint,
      PolicyErrorCode.WRONG_MINT,
      "Intent mint is not a valid address."
    )
    if (!mint.equals(new PublicKey(merchant.supportedTokenMint))) {
      return yield* fail(
        PolicyErrorCode.WRONG_MINT,
        "Intent mint differs from the configured USDC mint."
      )
    }
    const recipient = yield* asPubkey(
      intent.recipient,
      PolicyErrorCode.RECIPIENT_MISMATCH,
      "Intent recipient is not a valid address."
    )
    if (!recipient.equals(new PublicKey(merchant.recipientWallet))) {
      return yield* fail(
        PolicyErrorCode.RECIPIENT_MISMATCH,
        "Intent recipient differs from the registered merchant wallet."
      )
    }

    // Decimals from chain, never hardcoded; amount stays integer micro units.
    const decimals = yield* Effect.tryPromise({
      try: () => reads.getMintDecimals(intent.tokenMint),
      catch: () =>
        new PolicyError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: "Could not read the USDC mint from RPC.",
        }),
    }).pipe(
      Effect.flatMap((d) =>
        Number.isInteger(d) && d >= 0 && d <= 9
          ? Effect.succeed(d)
          : Effect.fail(
              new PolicyError({
                code: PolicyErrorCode.INTERNAL_ERROR,
                message: "USDC mint decimals out of range.",
              })
            )
      )
    )

    return yield* buildWithAtas(input, merchant, sender, mint, recipient, decimals, reads)
  })

const buildWithAtas = (
  input: BuildInput,
  merchant: MerchantConfig,
  sender: PublicKey,
  mint: PublicKey,
  recipient: PublicKey,
  decimals: number,
  reads: SolanaReads
): Effect.Effect<BuiltTransaction, PolicyError> =>
  Effect.gen(function* () {
    const { intent } = input
    const senderAtaKey = yield* Effect.tryPromise({
      try: () =>
        getAssociatedTokenAddress(mint, sender, false, TOKEN_PROGRAM_ID),
      catch: () =>
        new PolicyError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: "Could not derive the sender token account.",
        }),
    })
    // Merchant ATA must pre-exist (ops setup before demo): creating it
    // inside the payment would silently charge the user rent.
    const recipientAtaKey = yield* Effect.tryPromise({
      try: () =>
        getAssociatedTokenAddress(mint, recipient, false, TOKEN_PROGRAM_ID),
      catch: () =>
        new PolicyError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: "Could not derive the merchant token account.",
        }),
    })
    const merchantAtaExists = yield* Effect.tryPromise({
      try: () => reads.getAccount(recipientAtaKey.toBase58()),
      catch: () =>
        new PolicyError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: "Could not check the merchant token account.",
        }),
    })
    if (!merchantAtaExists) {
      return yield* fail(
        PolicyErrorCode.MERCHANT_ATA_MISSING,
        "Merchant USDC account does not exist — create it before the demo."
      )
    }

    const blockhash = yield* Effect.tryPromise({
      try: () => reads.getLatestBlockhash(),
      catch: () =>
        new PolicyError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: "Could not fetch a recent blockhash.",
        }),
    })

    // Unsigned by construction: no signer is ever consulted here.
    const tx = new Transaction()
    tx.feePayer = sender
    tx.recentBlockhash = blockhash
    tx.add(
      createTransferCheckedInstruction(
        senderAtaKey,
        mint,
        recipientAtaKey,
        sender,
        BigInt(intent.amountMicroUsdc),
        decimals
      )
    )

    return {
      intentId: intent.intentId,
      transaction: tx.serialize({ requireAllSignatures: false }).toString("base64"),
      sender: sender.toBase58(),
      senderAta: senderAtaKey.toBase58(),
      recipientAta: recipientAtaKey.toBase58(),
      mint: mint.toBase58(),
      amountMicroUsdc: intent.amountMicroUsdc,
      decimals,
      blockhash,
    }
  })
