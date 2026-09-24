import { describe, expect, it } from "vitest"
import { formatMicroUsdc, shortWallet } from "./format.js"

describe("summary formatting (BER-136)", () => {
  it("renders micro-USDC without floats", () => {
    expect(formatMicroUsdc(5_000_000)).toBe("5")
    expect(formatMicroUsdc(5_500_000)).toBe("5.5")
    expect(formatMicroUsdc(1)).toBe("0.000001")
  })

  it("shortens wallets but keeps short ones intact", () => {
    expect(shortWallet("11111111111111111111111111111111")).toBe("1111…1111")
    expect(shortWallet("abc")).toBe("abc")
  })
})
