import { describe, expect, it } from "vitest"
import { Cause, Effect, Schema } from "effect"
import {
  PaymentIntent,
  validIntentFixture,
  type MerchantConfig,
  type PaymentIntent as PaymentIntentType,
} from "@pact/shared"
import { verifyPayment } from "./verifier.js"
import type { FetchedReceipt } from "./receipt.js"
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token"
import { PublicKey } from "@solana/web3.js"

const DUMMY_WALLET = "11111111111111111111111111111111"
const DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

const merchant: MerchantConfig = {
  merchantId: "pact-coffee-demo",
  displayName: "Pact Coffee Demo",
  recipientWallet: DUMMY_WALLET,
  supportedTokenMint: DEVNET_MINT,
  network: "devnet",
  spendingLimitUsdc: 50,
  active: true,
}

const intent = (): PaymentIntentType => {
  const base = Schema.decodeUnknownSync(PaymentIntent)(validIntentFixture())
  return { ...base, status: "CONFIRMED" as const }
}

const receipt = (patch: Record<string, unknown> = {}): FetchedReceipt =>
  ({
    signature: "SIG_valid_11111111111111111111111111111111111111111111",
    status: "finalized",
    slot: 99,
    blockTime: 1780000000,
    executionErr: null,
    transfer: {
      authority: "AUTH_SENDER_11111111111111111111111111111111",
      sourceAta: "SRC_ATA_11111111111111111111111111111111111",
      destinationAta: "DST_FOR_MERCHANT",
      mint: DEVNET_MINT,
      amountMicro: 5_000_000,
      decimals: 6,
    },
    transaction: {},
    ...patch,
  }) as unknown as FetchedReceipt

const merchantAta = async (): Promise<string> =>
  (
    await getAssociatedTokenAddress(
      new PublicKey(DEVNET_MINT),
      new PublicKey(DUMMY_WALLET),
      false,
      TOKEN_PROGRAM_ID
    )
  ).toBase58()

const matchingReceipt = async (): Promise<FetchedReceipt> =>
  receipt({
    transfer: {
      authority: "AUTH_SENDER_11111111111111111111111111111111",
      sourceAta: "SRC_ATA_11111111111111111111111111111111111",
      destinationAta: await merchantAta(),
      mint: DEVNET_MINT,
      amountMicro: 5_000_000,
      decimals: 6,
    },
  })

const codeOf = async (
  i: PaymentIntentType,
  r: FetchedReceipt
): Promise<string> => {
  const exit = await Effect.runPromiseExit(verifyPayment(i, r, merchant))
  if (exit._tag === "Success") {
    return "OK"
  }
  const opt = Cause.failureOption(exit.cause)
  if (opt._tag === "None") {
    throw new Error("expected typed failure")
  }
  return `${opt.value.code}:${String(opt.value.message).split(":")[0]}`
}

describe("payment verifier (BER-144)", () => {
  it("verifies a fully matching payment", async () => {
    const exit = await Effect.runPromiseExit(
      verifyPayment(intent(), await matchingReceipt(), merchant)
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.slot).toBe(99)
      expect(exit.value.intentId).toBe(intent().intentId)
    }
  })

  it("rejects failed execution and unparseable transfers", async () => {
    expect(await codeOf(intent(), receipt({ executionErr: { Err: 1 } }))).toBe(
      "VERIFICATION_FAILED:execution-failed"
    )
    expect(await codeOf(intent(), receipt({ transfer: null }))).toBe(
      "VERIFICATION_FAILED:unparseable-transfer"
    )
  })

  it("rejects each field mismatch with a stable reason", async () => {
    const cases: Array<[string, string]> = [
      ["network", "VERIFICATION_FAILED:network"],
      ["mint", "VERIFICATION_FAILED:mint"],
      ["amount", "VERIFICATION_FAILED:amount"],
      ["sender", "VERIFICATION_FAILED:sender"],
      ["recipient", "VERIFICATION_FAILED:recipient"],
    ]
    const patches: Record<string, { i: Record<string, unknown>; t: Record<string, unknown> }> = {
      network: { i: { network: "mainnet-beta" }, t: {} },
      mint: { i: {}, t: { mint: "MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" } },
      amount: { i: {}, t: { amountMicro: 1 } },
      sender: { i: { userWallet: DUMMY_WALLET }, t: {} },
      recipient: { i: {}, t: { destinationAta: "DST_ELSEWHERE_11111111111111111111" } },
    }
    for (const [name, expected] of cases) {
      const p = patches[name]
      const matched = await matchingReceipt()
      expect(
        await codeOf(
          { ...intent(), ...p.i } as PaymentIntentType,
          receipt({ transfer: { ...(matched.transfer as object), ...p.t } })
        ),
        name
      ).toBe(expected)
    }
  })

  it("accepts unset userWallet with any valid authority", async () => {
    expect(await codeOf(intent(), await matchingReceipt())).toBe("OK")
  })
})
