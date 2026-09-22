import { describe, expect, it } from "vitest"
import { MAX_REQUEST_CHARS, validateRequestText } from "./request.js"

describe("request input validation (BER-130)", () => {
  it("accepts a normal request and trims it", () => {
    const result = validateRequestText("  Pay 5 USDC to Pact Coffee  \n")
    expect(result).toEqual({ ok: true, text: "Pay 5 USDC to Pact Coffee" })
  })

  it("rejects empty and blank input", () => {
    expect(validateRequestText("").ok).toBe(false)
    expect(validateRequestText("   \n\t  ").ok).toBe(false)
  })

  it("rejects oversize input with the count", () => {
    const result = validateRequestText("x".repeat(MAX_REQUEST_CHARS + 1))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(String(MAX_REQUEST_CHARS + 1))
    }
  })
})
