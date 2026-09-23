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

/**
 * ISO-8601 UTC instant string (expiry, createdAt, updatedAt).
 * Format gate only — "is it already expired?" is policy (BER-135).
 * Strict calendar check (Codex P2): Date.parse normalizes impossible
 * dates (2023-02-29 -> Mar 1), so components are compared back —
 * a normalized instant must never silently extend validity.
 */
const ISO_COMPONENTS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const isRealCalendarInstant = (s: string): boolean => {
  const m = ISO_COMPONENTS.exec(s)
  if (!m) {
    return false
  }
  const ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0
  const d = new Date(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms)
  )
  return (
    d.getUTCFullYear() === +m[1] &&
    d.getUTCMonth() === +m[2] - 1 &&
    d.getUTCDate() === +m[3] &&
    d.getUTCHours() === +m[4] &&
    d.getUTCMinutes() === +m[5] &&
    d.getUTCSeconds() === +m[6] &&
    d.getUTCMilliseconds() === ms
  )
}

export const IsoDateTime = Schema.String.pipe(
  Schema.filter(isRealCalendarInstant, {
    message: () => "expected a real ISO-8601 UTC calendar instant"
  })
).pipe(Schema.annotations({ identifier: "IsoDateTime" }))
export type IsoDateTime = typeof IsoDateTime.Type

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
  // Unique id, format intent_<32 hex>. Created by createIntentId().
  intentId: Schema.String.pipe(
    Schema.pattern(/^intent_[A-Za-z0-9]{8,64}$/, {
      message: () => "intentId must look like intent_<id>"
    })
  ),
  // Lifecycle status (SRS §16.6). Transitions are enforced by the
  // Confirmation Controller (BER-137), never by this schema alone.
  status: PaymentStatus,
  // Pre-registered merchant id. Must exist in the MerchantConfig (BER-133);
  // unknown ids are rejected by the policy engine (BER-134), not here.
  merchantId: Schema.NonEmptyString,
  // Amount in USDC minor units (micro-USDC, 1 USDC = 1_000_000).
  // Integer-only: no floats anywhere near money. Upper bound is a sanity
  // cap; the merchant spending limit is enforced by policy (BER-135).
  amountMicroUsdc: Schema.Int.pipe(
    Schema.positive({ message: () => "amount must be positive" }),
    Schema.lessThanOrEqualTo(1_000_000_000_000, {
      message: () => "amount exceeds the schema sanity cap (1M USDC)"
    })
  ),
  // PoC supports exactly one token.
  token: Schema.Literal("USDC"),
  // Must equal the configured USDC mint (BER-134).
  tokenMint: SolanaAddress,
  network: SolanaNetwork,
  // Resolved recipient wallet. Must equal the registered merchant wallet —
  // arbitrary addresses are rejected by policy (BER-135), not here.
  recipient: SolanaAddress,
  // Raw recipient mention from the user text (e.g. "Pact Coffee").
  // Audit context only; never used for execution.
  recipientReference: Schema.optional(Schema.String.pipe(Schema.maxLength(120))),
  // User-declared purpose/memo. Optional: a payer may state no purpose.
  purpose: Schema.optional(Schema.String.pipe(Schema.maxLength(280))),
  // The user's wallet. Unknown until wallet connection (Sprint 2, BER-138),
  // so intents are created without it.
  userWallet: Schema.optional(SolanaAddress),
  // ISO-8601 UTC instants. Expiry enforcement is policy (BER-135):
  // the parser (BER-132) sets expiry = now + TTL, validators reject past ones.
  expiry: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime
}).pipe(Schema.annotations({ identifier: "PaymentIntent" }))
export type PaymentIntent = typeof PaymentIntent.Type

/** 1 USDC = 1_000_000 minor units (SPL has 6 decimals). */
export const MICRO_USDC_PER_USDC = 1_000_000

/** intent_<32 hex>, e.g. intent_9f3c… — collision-safe for the PoC. */
export const createIntentId = (): string =>
  `intent_${crypto.randomUUID().replace(/-/g, "")}`

/** Render integer micro-USDC without floats: 5500000 -> "5.5". */
export const formatMicroUsdc = (microUsdc: number): string => {
  const whole = Math.trunc(microUsdc / MICRO_USDC_PER_USDC)
  const frac = Math.abs(microUsdc % MICRO_USDC_PER_USDC)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "")
  return frac.length === 0 ? String(whole) : `${whole}.${frac}`
}

/** Pure expiry check shared by policy (BER-135) and UI countdowns. */
export const isExpired = (intent: PaymentIntent, now: Date = new Date()): boolean =>
  Date.parse(intent.expiry) <= now.getTime()

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
