import { Schema } from "effect"

/**
 * BER-131 placeholder: canonical PaymentIntent schema.
 * Full fields (merchant, amount, token, network, recipient, purpose,
 * expiry, intentId, status) land in BER-131. BER-129 only needs the
 * module boundary so parser/validator/UI import from one place.
 */

export const SolanaNetwork = Schema.Literal("devnet", "testnet", "mainnet-beta")
export type SolanaNetwork = typeof SolanaNetwork.Type

export const PaymentStatus = Schema.Literal(
  "DRAFT",
  "PARSED",
  "VALIDATED",
  "AWAITING_CONFIRMATION",
  "CONFIRMED",
  "CANCELLED",
  "SIGNING",
  "SUBMITTED",
  "VERIFYING",
  "VERIFIED",
  "REJECTED",
  "FAILED",
  "VERIFICATION_FAILED",
  "EXPIRED"
)
export type PaymentStatus = typeof PaymentStatus.Type

export const PaymentIntent = Schema.Struct({
  intentId: Schema.String,
  status: PaymentStatus,
  // Remaining fields (merchantId, amount, tokenMint, network, recipient,
  // purpose, expiry, timestamps) are defined in BER-131.
}).pipe(Schema.annotations({ identifier: "PaymentIntent" }))
export type PaymentIntent = typeof PaymentIntent.Type

export const MerchantConfig = Schema.Struct({
  merchantId: Schema.String,
  displayName: Schema.String,
  recipientWallet: Schema.String,
  supportedTokenMint: Schema.String,
  network: SolanaNetwork,
  spendingLimitUsdc: Schema.Number,
  active: Schema.Boolean
}).pipe(Schema.annotations({ identifier: "MerchantConfig" }))
export type MerchantConfig = typeof MerchantConfig.Type
