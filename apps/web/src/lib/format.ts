/**
 * BER-136: integer micro-USDC formatting for the summary view.
 * Dependency-free like request.ts (no effect in the browser bundle);
 * mirrors shared formatMicroUsdc, which remains the server authority.
 */
export const MICRO_USDC_PER_USDC = 1_000_000

export const formatMicroUsdc = (microUsdc: number): string => {
  const whole = Math.trunc(microUsdc / MICRO_USDC_PER_USDC)
  const frac = Math.abs(microUsdc % MICRO_USDC_PER_USDC)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "")
  return frac.length === 0 ? String(whole) : `${whole}.${frac}`
}

/** Middle-truncated wallet for tight layouts (full value stays in title). */
export const shortWallet = (address: string): string =>
  address.length <= 12
    ? address
    : `${address.slice(0, 4)}…${address.slice(-4)}`
