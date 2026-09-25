/**
 * BER-141: pure signing-eligibility gate (unit-tested, no wallet).
 *
 * Signing is available ONLY when every fact lines up on the SAME payment:
 * a sealed CONFIRMED intent, a fresh preflight OK for that intent, an
 * unsigned build for that intent, and the currently connected wallet
 * equal to the preflight-approved sender. Anything else keeps the Sign
 * button disabled — signing is impossible before confirmation+preflight.
 */

import { Transaction } from "@solana/web3.js";
import { base64ToBytes } from "./base64.js";

export interface SigningState {
  /** Intent the UI currently authorizes (null when retired). */
  intentId: string | null;
  /** ISO expiry of the authorized intent (staged builds carry none). */
  expiresAt: string | null;
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
  | "INTENT_EXPIRED"
  | "PREFLIGHT_NOT_OK"
  | "STALE_PREFLIGHT"
  | "NO_UNSIGNED_TX"
  | "WALLET_MISMATCH"
  | "WALLET_NOT_CONNECTED";

export const canSign = (
  state: SigningState,
  now: Date = new Date()
): { eligible: true } | { eligible: false; reason: SigningBlockReason } => {
  if (state.intentId === null) {
    return { eligible: false, reason: "NO_INTENT" };
  }
  // Staged builds carry the intent expiry (Codex P1 PR #13): signing past
  // it would produce a payload the execution policy rejects as EXPIRED.
  if (
    state.expiresAt !== null &&
    Number(Date.parse(state.expiresAt)) <= now.getTime()
  ) {
    return { eligible: false, reason: "INTENT_EXPIRED" };
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

/**
 * Post-signing verification (Qodo 2 PR #13): the signed result is approved
 * only when its message is byte-identical to the reviewed transaction, the
 * expected wallet holds a slot, and signatures verify cryptographically.
 * Anything else (substituted message, foreign key, unsigned) is rejected.
 */
export const verifySignedTransaction = (
  originalBase64: string,
  signedBase64: string,
  expectedSigner: string
): boolean => {
  try {
    const original = Transaction.from(base64ToBytes(originalBase64));
    const signed = Transaction.from(base64ToBytes(signedBase64));
    // web3.js v1 exposes the message via compileMessage(), not .message.
    const a = original.compileMessage().serialize();
    const b = signed.compileMessage().serialize();
    if (a.length !== b.length || !a.every((v, i) => v === b[i])) {
      return false;
    }
    if (signed.feePayer?.toBase58() !== expectedSigner) {
      return false;
    }
    const slot = signed.signatures.find(
      (s) => s.publicKey.toBase58() === expectedSigner
    );
    if (slot === undefined || slot.signature === null) {
      return false;
    }
    return signed.verifySignatures();
  } catch {
    return false;
  }
};

/**
 * Normalized user-rejection predicate (Qodo 6 + Codex P2 PR #13):
 * WalletSignTransactionError wraps EVERY provider failure, so only
 * documented rejection codes/messages count as rejection. Everything
 * else is an operational error with a bounded diagnostic.
 */
const REJECTION_PATTERNS = [
  /user rejected/i,
  /rejected the request/i,
  /user denied/i,
  /user (cancelled|canceled)/i,
  /request (cancelled|canceled|dismissed|denied)/i,
  /action_rejected/i,
];

export const isUserRejection = (err: unknown): boolean => {
  if (err === null || err === undefined) {
    return false;
  }
  const record = err as { code?: unknown; message?: unknown; name?: unknown };
  if (typeof record.code === "number" && record.code === 4001) {
    return true;
  }
  const haystack = [record.message, record.name]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return REJECTION_PATTERNS.some((re) => re.test(haystack));
};
