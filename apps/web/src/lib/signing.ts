/**
 * BER-141: pure signing-eligibility gate (unit-tested, no wallet).
 *
 * Signing is available ONLY when every fact lines up on the SAME payment:
 * a sealed CONFIRMED intent, a fresh preflight OK for that intent, an
 * unsigned build for that intent, and the currently connected wallet
 * equal to the preflight-approved sender. Anything else keeps the Sign
 * button disabled — signing is impossible before confirmation+preflight.
 */

export interface SigningState {
  /** Intent the UI currently authorizes (null when retired). */
  intentId: string | null;
  /** Latest preflight verdict for that intent. */
  preflightOk: boolean;
  preflightIntentId: string | null;
  /** Wallet currently connected in the adapter. */
  connectedPubkey: string | null;
  /** Sender the unsigned build was approved for. */
  buildSender: string | null;
  /** Intent the unsigned build was made for. */
  buildIntentId: string | null;
  /** Whether an unsigned build exists and is displayed. */
  hasUnsignedTx: boolean;
}

export type SigningBlockReason =
  | "NO_INTENT"
  | "PREFLIGHT_NOT_OK"
  | "STALE_PREFLIGHT"
  | "NO_UNSIGNED_TX"
  | "WALLET_MISMATCH"
  | "WALLET_NOT_CONNECTED";

export const canSign = (
  state: SigningState
): { eligible: true } | { eligible: false; reason: SigningBlockReason } => {
  if (state.intentId === null) {
    return { eligible: false, reason: "NO_INTENT" };
  }
  if (state.preflightIntentId !== state.intentId) {
    return { eligible: false, reason: "STALE_PREFLIGHT" };
  }
  if (!state.preflightOk) {
    return { eligible: false, reason: "PREFLIGHT_NOT_OK" };
  }
  if (!state.hasUnsignedTx || state.buildIntentId !== state.intentId) {
    return { eligible: false, reason: "NO_UNSIGNED_TX" };
  }
  if (state.connectedPubkey === null) {
    return { eligible: false, reason: "WALLET_NOT_CONNECTED" };
  }
  if (state.buildSender === null || state.buildSender !== state.connectedPubkey) {
    return { eligible: false, reason: "WALLET_MISMATCH" };
  }
  // Preflight codes are informational here — eligibility is boolean, and
  // the panel shows the underlying preflight issues separately.
  return { eligible: true };
};
