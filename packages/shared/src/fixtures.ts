/**
 * BER-131: canonical fixtures for the PaymentIntent boundary.
 *
 * Fixtures are raw `unknown` JSON — exactly what an AI parser (BER-132)
 * or a client would hand over. Everything must pass
 * `Schema.decodeUnknown(PaymentIntent)` (valid) or fail it (invalid).
 * The policy engine (BER-134/135) maps these shapes to stable
 * PolicyErrorCode values; the schema itself only accepts/rejects.
 */

const DUMMY_WALLET = "11111111111111111111111111111111"
const DEVNET_USDC_MINT = "4zMMC9sEqf9MKyRbf3Tx3sQAr1BLWnCQcHjEXtGbm4o"

const baseValidIntent = {
  intentId: "intent_9f3c2ab41d5e4789a6b7c8d9e0f1a2b3",
  status: "DRAFT",
  merchantId: "pact-coffee-demo",
  amountMicroUsdc: 5_000_000,
  token: "USDC",
  tokenMint: DEVNET_USDC_MINT,
  network: "devnet",
  recipient: DUMMY_WALLET,
  recipientReference: "Pact Coffee",
  purpose: "oat latte",
  expiry: "2030-01-01T00:15:00.000Z",
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z"
} as const

/** A fully-populated valid intent (no userWallet yet — Sprint 2). */
export const validIntentFixture = (): unknown =>
  JSON.parse(JSON.stringify(baseValidIntent)) as unknown

/** Minimal valid intent: optional fields omitted. */
export const minimalValidIntentFixture = (): unknown => {
  const { recipientReference, purpose, userWallet, ...rest } =
    baseValidIntent as unknown as Record<string, unknown>
  void recipientReference
  void purpose
  void userWallet
  return JSON.parse(JSON.stringify(rest)) as unknown
}

export interface InvalidIntentFixture {
  name: string
  why: string
  data: unknown
}

/** One broken field each — every entry must FAIL schema decode. */
export const invalidIntentFixtures = (): InvalidIntentFixture[] => {
  const bad = (name: string, why: string, patch: Record<string, unknown>) => ({
    name,
    why,
    data: { ...JSON.parse(JSON.stringify(baseValidIntent)), ...patch }
  })
  return [
    bad("bad-intent-id", "intentId format", { intentId: "abc123" }),
    bad("unknown-status", "status enum", { status: "PAID" }),
    bad("blank-merchant", "merchantId required", { merchantId: "" }),
    bad("zero-amount", "amount positive", { amountMicroUsdc: 0 }),
    bad("negative-amount", "amount positive", { amountMicroUsdc: -100 }),
    bad("fractional-amount", "amount integer micro-USDC", {
      amountMicroUsdc: 5.5
    }),
    bad("absurd-amount", "sanity cap", { amountMicroUsdc: 2_000_000_000_000 }),
    bad("wrong-token", "token literal USDC", { token: "SOL" }),
    bad("bad-mint", "tokenMint pubkey", { tokenMint: "not-a-mint" }),
    bad("bad-network", "network enum", { network: "ethereum" }),
    bad("bad-recipient", "recipient pubkey", { recipient: "attacker" }),
    bad("bad-expiry", "expiry ISO instant", { expiry: "tomorrow" }),
    bad("impossible-expiry", "real calendar date (2030 not a leap year)", {
      expiry: "2030-02-29T00:00:00.000Z"
    }),
    bad("impossible-created-at", "real calendar date", {
      createdAt: "2023-02-30T00:00:00Z"
    }),
    bad("bad-created-at", "createdAt ISO instant", {
      createdAt: "01/01/2030"
    }),
    bad("oversize-purpose", "purpose max 280", { purpose: "x".repeat(281) })
  ]
}
