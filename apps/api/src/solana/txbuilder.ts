import { Effect } from "effect"
import base58 from "bs58"
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
  genesisMatchesNetwork,
  type MerchantConfig,
  type SolanaNetwork,
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
  /** Broadcast signed bytes; returns the transaction signature. */
  sendRawTransaction(serialized: Uint8Array): Promise<string>
  /** Genesis hash of the connected cluster. */
  getGenesisHash(): Promise<string>
}

/** Genesis is immutable: cache per reads object for the process lifetime. */
const genesisCache = new WeakMap<object, string>()

/**
 * Backend cluster guard (Codex P1 PR #14): the RPC behind build/submit
 * must serve the configured intent network. Solana messages carry no
 * chain identifier, so a mainnet-overridden SOLANA_RPC_URL would
 * otherwise sign on one displayed network and land on another.
 * Fail-closed INTERNAL_ERROR (server misconfiguration, logged).
 */
export const assertRpcCluster = (
  reads: SolanaReads,
  network: SolanaNetwork
): Effect.Effect<void, PolicyError> =>
  Effect.gen(function* () {
    const cached = genesisCache.get(reads)
    const hash =
      cached ??
      (yield* Effect.tryPromise({
        try: () => reads.getGenesisHash(),
        catch: () =>
          new PolicyError({
            code: PolicyErrorCode.INTERNAL_ERROR,
            message: "Could not verify the backend RPC cluster.",
          }),
      }))
    genesisCache.set(reads, hash)
    if (!genesisMatchesNetwork(network, hash)) {
      return yield* fail(
        PolicyErrorCode.INTERNAL_ERROR,
        `Backend RPC serves an unexpected cluster (expected ${network}).`
      )
    }
  })

export const liveSolanaReads = (rpcUrl: string): SolanaReads => {
  const connection = new Connection(rpcUrl, "confirmed")
  return {
    getLatestBlockhash: () =>
      connection.getLatestBlockhash("confirmed").then((b) => b.blockhash),
    getAccount: (publicKey: string) =>
      connection
        .getAccountInfo(new PublicKey(publicKey))
        .then((info: AccountInfo<Buffer> | null) => info !== null),
    getMintDecimals: (mint: string) =>
      connection.getTokenSupply(new PublicKey(mint)).then((supply) => {
        const decimals = supply.value.decimals
        if (typeof decimals !== "number") {
          throw new Error("mint decimals unreadable")
        }
        return decimals
      }),
    // Simulation-enabled send: the RPC pre-checks before accepting.
    sendRawTransaction: (serialized: Uint8Array) =>
      connection.sendRawTransaction(serialized, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      }),
    getGenesisHash: () => connection.getGenesisHash(),
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

    // Backend cluster first: every subsequent read targets this RPC.
    yield* assertRpcCluster(reads, intent.network)

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

    // Decimals must be exactly six: amountMicroUsdc is defined as fixed
    // six-decimal micro-USDC everywhere (schema, UI, policy). Any other
    // precision would silently transfer a different quantity (Qodo/Codex
    // PR #12: 5_000_000 at 5 decimals = 50 tokens, at 9 = 0.005).
    const decimals = yield* Effect.tryPromise({
      try: () => reads.getMintDecimals(intent.tokenMint),
      catch: () =>
        new PolicyError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: "Could not read the USDC mint from RPC.",
        }),
    }).pipe(
      Effect.flatMap((d) =>
        d === 6
          ? Effect.succeed(d)
          : Effect.fail(
              new PolicyError({
                code: PolicyErrorCode.INTERNAL_ERROR,
                message: `USDC mint reports ${d} decimals; Pact requires exactly 6.`,
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

/**
 * Submission-time verification (Qodo 1 + Codex P1 PR #14): the signed
 * transaction must BE the authorized payment — same mint, recipient,
 * amount, and precision as the sealed CONFIRMED intent, signed by the
 * bound sender, cryptographically valid. Anything else is INVALID_REQUEST
 * before any broadcast: unrelated/foreign-signed/substituted payloads can
 * never consume the intent or pollute the attempt trail.
 *
 * Sender rule mirrors the builder: when the intent binds a wallet, the
 * fee payer must equal it; otherwise any valid fee payer that signed is
 * accepted (the wallet UI showed the user exactly this transaction).
 */
export const verifySignedTransfer = (
  signedBase64: string,
  intent: ConfirmedIntent,
  merchant: MerchantConfig
): Effect.Effect<{ feePayer: string; signature: string }, PolicyError> =>
  Effect.gen(function* () {
    const signed = yield* Effect.try({
      try: () =>
        Transaction.from(Buffer.from(signedBase64, "base64")),
      catch: () =>
        new PolicyError({
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Signed transaction is not decodable.",
        }),
    })
    // Exactly one instruction, and it must be our TransferChecked.
    if (signed.instructions.length !== 1) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Transaction must contain exactly the authorized transfer instruction."
      )
    }
    const ix = signed.instructions[0]
    if (!ix.programId.equals(TOKEN_PROGRAM_ID)) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Transaction program is not the SPL Token program."
      )
    }
    const data = Buffer.from(ix.data)
    if (data[0] !== 12) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Transaction instruction is not a checked token transfer."
      )
    }
    const amount = Number(data.readBigUInt64LE(1))
    const decimals = data[9]
    if (
      amount !== intent.amountMicroUsdc ||
      decimals !== 6 ||
      ix.keys.length < 4
    ) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Transaction amount or precision differs from the authorized intent."
      )
    }
    // Fee payer must be a valid signer of this transaction, and must equal
    // the bound wallet when the intent carries one.
    const feePayer = signed.feePayer?.toBase58() ?? null
    if (feePayer === null) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Transaction has no fee payer."
      )
    }
    if (intent.userWallet !== undefined && intent.userWallet !== feePayer) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Transaction fee payer is not the wallet bound to this intent."
      )
    }
    const slot = signed.signatures.find(
      (s) => s.publicKey.toBase58() === feePayer
    )
    if (slot === undefined || slot.signature === null) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Fee payer has not signed this transaction."
      )
    }
    const [sourceAta, destAta] = yield* Effect.tryPromise({
      try: async () => {
        const mintKey = new PublicKey(intent.tokenMint)
        const senderKey = new PublicKey(feePayer)
        const recipientKey = new PublicKey(intent.recipient)
        return [
          (
            await getAssociatedTokenAddress(mintKey, senderKey, false, TOKEN_PROGRAM_ID)
          ).toBase58(),
          (
            await getAssociatedTokenAddress(mintKey, recipientKey, false, TOKEN_PROGRAM_ID)
          ).toBase58(),
        ] as const
      },
      catch: () =>
        new PolicyError({
          code: PolicyErrorCode.INTERNAL_ERROR,
          message: "Could not derive expected token accounts.",
        }),
    })
    if (
      ix.keys[0].pubkey.toBase58() !== sourceAta ||
      ix.keys[1].pubkey.toBase58() !== intent.tokenMint ||
      ix.keys[1].pubkey.toBase58() !== merchant.supportedTokenMint ||
      ix.keys[2].pubkey.toBase58() !== destAta
    ) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Transaction accounts differ from the authorized build."
      )
    }
    if (!signed.verifySignatures()) {
      return yield* fail(
        PolicyErrorCode.INVALID_REQUEST,
        "Transaction signatures do not verify."
      )
    }
    return {
      feePayer,
      signature: base58.encode(Buffer.from(slot.signature)),
    }
  })
