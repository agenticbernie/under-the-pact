import { createHmac, timingSafeEqual } from "node:crypto"
import type { PaymentIntent } from "@pact/shared"

/**
 * Intent integrity seal (Qodo PR #7: forged client intents).
 *
 * The validate/confirm steps must not trust a client-supplied intent at
 * face value: `status: "PARSED"` is trivially forgeable, so a tampered
 * amount or expiry would otherwise come back VALIDATED. The parser signs
 * every field with a server-only HMAC secret; validation and confirmation
 * re-verify before doing anything. No persistence needed, works across
 * Neon isolates (stateless), and Sprint 3's intent store replaces it.
 *
 * Seal is integrity, NOT authorization — the wallet signature (Sprint 2)
 * remains the only authorization. A valid seal on a tampered intent is
 * impossible without the secret; a valid seal on an honest intent still
 * goes through full policy.
 */

const SEALED_FIELDS = [
  "intentId",
  "status",
  "merchantId",
  "amountMicroUsdc",
  "token",
  "tokenMint",
  "network",
  "recipient",
  "recipientReference",
  "purpose",
  "userWallet",
  "expiry",
  "createdAt",
  "updatedAt"
] as const

type Sealable = Record<(typeof SEALED_FIELDS)[number], unknown>

/** Canonical projection: fixed order, undefined preserved as null. */
const canonical = (intent: PaymentIntent): string => {
  const record = intent as unknown as Sealable
  const projected: Record<string, unknown> = {}
  for (const field of SEALED_FIELDS) {
    projected[field] = record[field] ?? null
  }
  return JSON.stringify(projected)
}

/** Sign all intent fields. Throws never — returns hex digest. */
export const sealIntent = (
  intent: PaymentIntent,
  secret: string
): PaymentIntent => ({
  ...intent,
  seal: createHmac("sha256", secret).update(canonical(intent)).digest("hex")
})

/** True only if the seal matches every current field value. */
export const verifyIntentSeal = (
  intent: PaymentIntent,
  secret: string
): boolean => {
  if (typeof intent.seal !== "string" || intent.seal.length === 0) {
    return false
  }
  const expected = createHmac("sha256", secret)
    .update(canonical(intent))
    .digest()
  let actual: Buffer
  try {
    actual = Buffer.from(intent.seal, "hex")
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
