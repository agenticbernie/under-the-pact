import { describe, expect, it } from "vitest"
import { Cause, Effect } from "effect"
import { Keypair, PublicKey, Transaction } from "@solana/web3.js"
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import {
  buildUsdcTransfer,
  verifySignedTransfer,
  type SolanaReads,
} from "./txbuilder.js"
import type { ConfirmedIntent } from "../intent/confirm.js"
import type { MerchantConfig } from "@pact/shared"

// Real-format fixtures only — no keypairs anywhere near the builder.
const SENDER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const MERCHANT_WALLET = "11111111111111111111111111111111"
const DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const BLOCKHASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"

const merchant: any = {
  merchantId: "pact-coffee-demo",
  displayName: "Pact Coffee Demo",
  recipientWallet: MERCHANT_WALLET,
  supportedTokenMint: DEVNET_MINT,
  network: "devnet",
  spendingLimitUsdc: 50,
  active: true,
}

const confirmedIntent = (patch: Record<string, unknown> = {}): ConfirmedIntent =>
  ({
    intentId: "intent_test_140",
    status: "CONFIRMED",
    merchantId: "pact-coffee-demo",
    amountMicroUsdc: 5_000_000,
    token: "USDC",
    tokenMint: DEVNET_MINT,
    network: "devnet",
    recipient: MERCHANT_WALLET,
    expiry: "2030-01-01T00:15:00.000Z",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    confirmedAt: "2030-01-01T00:00:01.000Z",
    ...patch,
  }) as ConfirmedIntent

const stubReads = (overrides: Partial<SolanaReads> = {}): SolanaReads => ({
  getLatestBlockhash: async () => BLOCKHASH,
  getAccount: async () => true,
  getMintDecimals: async () => 6,
  getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  sendRawTransaction: async () => "SIG_test_11111111111111111111111111111111",
  ...overrides,
})

const build = (
  intent: ConfirmedIntent = confirmedIntent(),
  sender: string = SENDER,
  reads: SolanaReads = stubReads()
) =>
  Effect.runPromiseExit(
    buildUsdcTransfer({ intent, sender, merchant, rpcUrl: "https://example.test", reads })
  )

const codeOf = async (
  intent: ConfirmedIntent = confirmedIntent(),
  sender: string = SENDER,
  reads: SolanaReads = stubReads()
): Promise<string> => {
  const exit = await build(intent, sender, reads)
  if (exit._tag === "Success") {
    return "OK"
  }
  const opt = Cause.failureOption(exit.cause)
  if (opt._tag === "None") {
    throw new Error("expected typed failure")
  }
  return (opt.value as { code: string }).code
}

describe("USDC transaction builder (BER-140)", () => {
  it("builds an inspectable unsigned transfer with exact fields", async () => {
    const exit = await build()
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") {
      return
    }
    const built = exit.value
    expect(built.intentId).toBe("intent_test_140")
    expect(built.amountMicroUsdc).toBe(5_000_000)
    expect(built.decimals).toBe(6)
    expect(built.mint).toBe(DEVNET_MINT)
    expect(built.sender).toBe(SENDER)
    expect(built.blockhash).toBe(BLOCKHASH)

    // Inspect the wire bytes: one TransferChecked instruction.
    const tx = Transaction.from(Buffer.from(built.transaction, "base64"))
    // Unsigned by construction: feePayer placeholder present, zero signatures.
    expect(tx.signatures.length).toBeGreaterThan(0)
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true)
    expect(tx.feePayer?.toBase58()).toBe(SENDER)
    expect(tx.recentBlockhash).toBe(BLOCKHASH)
    expect(tx.instructions).toHaveLength(1)
    const ix = tx.instructions[0]
    expect(ix.programId.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58())
    const senderAta = (
      await getAssociatedTokenAddress(
        new PublicKey(DEVNET_MINT),
        new PublicKey(SENDER),
        false,
        TOKEN_PROGRAM_ID
      )
    ).toBase58()
    const merchantAta = (
      await getAssociatedTokenAddress(
        new PublicKey(DEVNET_MINT),
        new PublicKey(MERCHANT_WALLET),
        false,
        TOKEN_PROGRAM_ID
      )
    ).toBase58()
    expect(built.senderAta).toBe(senderAta)
    expect(built.recipientAta).toBe(merchantAta)
    expect(ix.keys[0].pubkey.toBase58()).toBe(senderAta)
    expect(ix.keys[2].pubkey.toBase58()).toBe(merchantAta)
    const data = Buffer.from(ix.data)
    expect(data[0]).toBe(12) // TransferChecked
    expect(Number(data.readBigUInt64LE(1))).toBe(5_000_000)
    expect(data[9]).toBe(6)
  })

  it("rejects sender mismatch, wrong mint, wrong recipient", async () => {
    expect(
      await codeOf(
        confirmedIntent({ userWallet: MERCHANT_WALLET }),
        SENDER
      )
    ).toBe("INVALID_REQUEST")
    expect(await codeOf(confirmedIntent({ tokenMint: SENDER }))).toBe(
      "WRONG_MINT"
    )
    expect(await codeOf(confirmedIntent({ recipient: SENDER }))).toBe(
      "RECIPIENT_MISMATCH"
    )
  })

  it("fails explicit when the merchant ATA is missing", async () => {
    expect(
      await codeOf(
        confirmedIntent(),
        SENDER,
        stubReads({ getAccount: async () => false })
      )
    ).toBe("MERCHANT_ATA_MISSING")
  })

  it("maps RPC failures to INTERNAL_ERROR, never a user code", async () => {
    expect(
      await codeOf(
        confirmedIntent(),
        SENDER,
        stubReads({
          getLatestBlockhash: async () => {
            throw new Error("down")
          },
        })
      )
    ).toBe("INTERNAL_ERROR")
  })

  it("rejects non-six-decimal mints instead of mispricing (Qodo/Codex PR #12)", async () => {
    for (const decimals of [0, 5, 9]) {
      expect(
        await codeOf(
          confirmedIntent(),
          SENDER,
          stubReads({ getMintDecimals: async () => decimals })
        ),
        `decimals ${decimals}`
      ).toBe("INTERNAL_ERROR")
    }
  })
})

describe("verifySignedTransfer (Qodo 1 + Codex P1 PR #14)", () => {
  // NOTE: ephemeral test-only keys (never shipped). Shipped sources must
  // contain no key material; the gate enforces it on non-test files.
  const merchant = {
    merchantId: "pact-coffee-demo",
    displayName: "P",
    recipientWallet: MERCHANT_WALLET,
    supportedTokenMint: DEVNET_MINT,
    network: "devnet",
    spendingLimitUsdc: 50,
    active: true,
  } as MerchantConfig
  const intent = {
    ...confirmedIntent(),
    userWallet: undefined,
  } as ConfirmedIntent

  const signBuilt = async (
    amountMicroUsdc: number = 5_000_000,
    signer: ReturnType<typeof Keypair.generate> | null = null
  ): Promise<{ b64: string; signer: string }> => {
    const kp = signer ?? Keypair.generate()
    const mint = new PublicKey(DEVNET_MINT)
    const senderAta = await getAssociatedTokenAddress(mint, kp.publicKey, false, TOKEN_PROGRAM_ID)
    const destAta = await getAssociatedTokenAddress(mint, new PublicKey(MERCHANT_WALLET), false, TOKEN_PROGRAM_ID)
    const tx = new Transaction()
    tx.feePayer = kp.publicKey
    tx.recentBlockhash = BLOCKHASH
    tx.add(
      createTransferCheckedInstruction(
        senderAta,
        mint,
        destAta,
        kp.publicKey,
        BigInt(amountMicroUsdc),
        6
      )
    )
    tx.partialSign(kp)
    return {
      b64: Buffer.from(tx.serialize()).toString("base64"),
      signer: kp.publicKey.toBase58(),
    }
  }

  const verifyCode = async (b64: string, forIntent: ConfirmedIntent = intent) => {
    const exit = await Effect.runPromiseExit(
      verifySignedTransfer(b64, forIntent, merchant)
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

  it("accepts the genuine authorized build", async () => {
    const { b64, signer } = await signBuilt()
    const exit = await Effect.runPromiseExit(
      verifySignedTransfer(b64, { ...intent, userWallet: signer }, merchant)
    )
    expect(exit._tag).toBe("Success")
  })

  it("rejects wrong amount, foreign program, unsigned, and wrong signer", async () => {
    // Wrong amount for this intent.
    const wrongAmount = await signBuilt(1)
    expect(await verifyCode(wrongAmount.b64)).toBe("INVALID_REQUEST")

    // Foreign program: System transfer signed by anyone.
    const kp = Keypair.generate()
    const sysTx = new Transaction()
    sysTx.feePayer = kp.publicKey
    sysTx.recentBlockhash = BLOCKHASH
    sysTx.add({
      keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }],
      programId: new PublicKey("11111111111111111111111111111111"),
      data: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    })
    sysTx.partialSign(kp)
    expect(
      await verifyCode(Buffer.from(sysTx.serialize()).toString("base64"))
    ).toBe("INVALID_REQUEST")

    // Correctly built but never signed.
    const mint = new PublicKey(DEVNET_MINT)
    const sender = Keypair.generate().publicKey
    const unsigned = new Transaction()
    unsigned.feePayer = sender
    unsigned.recentBlockhash = BLOCKHASH
    unsigned.add(
      createTransferCheckedInstruction(
        await getAssociatedTokenAddress(mint, sender, false, TOKEN_PROGRAM_ID),
        mint,
        await getAssociatedTokenAddress(mint, new PublicKey(MERCHANT_WALLET), false, TOKEN_PROGRAM_ID),
        sender,
        BigInt(5_000_000),
        6
      )
    )
    expect(
      await verifyCode(
        Buffer.from(unsigned.serialize({ requireAllSignatures: false })).toString("base64")
      )
    ).toBe("INVALID_REQUEST")

    // Bound wallet mismatch.
    const { b64 } = await signBuilt()
    expect(
      await verifyCode(
        b64,
        { ...intent, userWallet: MERCHANT_WALLET } as ConfirmedIntent
      )
    ).toBe("INVALID_REQUEST")
  })
})

describe("backend cluster guard on build (Codex P1 PR #14)", () => {
  it("refuses to build against the wrong cluster", async () => {
    const exit = await Effect.runPromiseExit(
      buildUsdcTransfer({
        intent: confirmedIntent(),
        sender: SENDER,
        merchant: merchant as never,
        rpcUrl: "https://example.test",
        reads: stubReads({
          getGenesisHash: async () =>
            "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
        }),
      })
    )
    expect(exit._tag).toBe("Failure")
  })
})
