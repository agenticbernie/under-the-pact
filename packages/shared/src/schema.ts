import { Schema } from "effect"
import base58 from "bs58"

/**
 * BER-131 placeholder: canonical PaymentIntent schema.
 * Full fields (merchant, amount, token, network, recipient, purpose,
 * expiry, intentId, status) land in BER-131. BER-129 only needs the
 * module boundary so parser/validator/UI import from one place.
 */

export const SolanaNetwork = Schema.Literal("devnet", "testnet", "mainnet-beta")
export type SolanaNetwork = typeof SolanaNetwork.Type

/**
 * Base58-encoded 32-byte Solana public key (wallet or mint).
 * Full format gate lives here so BER-133 (merchant registry) reuses it.
 */
const isSolanaAddress = (s: string): boolean => {
  try {
    return base58.decode(s).length === 32
  } catch {
    return false
  }
}

export const SolanaAddress = Schema.String.pipe(
  Schema.filter(isSolanaAddress, {
    message: () => "expected a base58 Solana public key (32 bytes)"
  })
).pipe(Schema.annotations({ identifier: "SolanaAddress" }))
export type SolanaAddress = typeof SolanaAddress.Type

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
  recipientWallet: SolanaAddress,
  supportedTokenMint: SolanaAddress,
  network: SolanaNetwork,
  spendingLimitUsdc: Schema.Number,
  active: Schema.Boolean
}).pipe(Schema.annotations({ identifier: "MerchantConfig" }))
export type MerchantConfig = typeof MerchantConfig.Type

/**
 * BER-130: raw natural-language payment request (REQ-F-001).
 * Trimmed client- and server-side; blank or over-long input is rejected
 * before it can reach the intent parser (BER-132).
 */
export const MAX_REQUEST_CHARS = 2000

export const PaymentRequest = Schema.Struct({
  text: Schema.String.pipe(
    Schema.minLength(1, {
      message: () => "payment request must not be empty"
    }),
    Schema.maxLength(MAX_REQUEST_CHARS, {
      message: () => `payment request must be at most ${MAX_REQUEST_CHARS} characters`
    }),
    Schema.filter((s) => s.trim().length > 0, {
      message: () => "payment request must not be blank"
    })
  )
}).pipe(Schema.annotations({ identifier: "PaymentRequest" }))
export type PaymentRequest = typeof PaymentRequest.Type

/** Canonical normalization applied by every consumer before validation. */
export const normalizeRequestText = (s: string): string => s.trim()
