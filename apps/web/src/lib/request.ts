/**
 * BER-130: client-side fast-fail for the NL payment request.
 *
 * Deliberately dependency-free (no effect/bs58 in the browser bundle).
 * Mirrors the server authority `@pact/shared` PaymentRequest
 * (MAX_REQUEST_CHARS, trimmed, non-blank) — the API re-validates
 * everything, so this is UX only, never a trust boundary.
 */

export const MAX_REQUEST_CHARS = 2000

export type RequestValidation =
  | { ok: true; text: string }
  | { ok: false; error: string }

export const validateRequestText = (raw: string): RequestValidation => {
  const text = raw.trim()
  if (text.length === 0) {
    return { ok: false, error: "Describe the payment first — request is empty." }
  }
  if (text.length > MAX_REQUEST_CHARS) {
    return {
      ok: false,
      error: `Request is too long (${text.length}/${MAX_REQUEST_CHARS} characters).`
    }
  }
  return { ok: true, text }
}
