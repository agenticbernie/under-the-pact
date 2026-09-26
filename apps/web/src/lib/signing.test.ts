import { describe, expect, it } from "vitest";
import { Keypair, Transaction } from "@solana/web3.js";
import {
  base64ToBytes,
  bytesToBase64,
} from "./base64.js";
import {
  canSign,
  isUserRejection,
  verifySignedTransaction,
  type SigningState,
} from "./signing.js";

const base: SigningState = {
  intentId: "intent_1",
  expiresAt: "2030-01-01T00:15:00.000Z",
  preflightOk: true,
  preflightIntentId: "intent_1",
  connectedPubkey: "Wallet111111111111111111111111111111111111",
  buildSender: "Wallet111111111111111111111111111111111111",
  buildIntentId: "intent_1",
  hasUnsignedTx: true,
};

const NOW = new Date("2030-01-01T00:00:00.000Z");

describe("signing gate (BER-141)", () => {
  it("allows signing only when everything lines up", () => {
    expect(canSign(base, NOW)).toEqual({ eligible: true });
  });

  it("blocks without intent, stale/failed preflight, or missing build", () => {
    expect(canSign({ ...base, intentId: null }, NOW).eligible).toBe(false);
    expect(
      canSign({ ...base, preflightIntentId: "intent_2" }, NOW)
    ).toEqual({ eligible: false, reason: "STALE_PREFLIGHT" });
    expect(
      canSign({ ...base, preflightOk: false, preflightIntentId: "intent_1" }, NOW)
    ).toEqual({ eligible: false, reason: "PREFLIGHT_NOT_OK" });
    expect(canSign({ ...base, hasUnsignedTx: false }, NOW).eligible).toBe(false);
    expect(
      canSign({ ...base, buildIntentId: "intent_2" }, NOW)
    ).toEqual({ eligible: false, reason: "NO_UNSIGNED_TX" });
  });

  it("blocks wallet mismatch or disconnect", () => {
    expect(
      canSign({ ...base, connectedPubkey: "Other11111111111111111111111111111111" }, NOW)
    ).toEqual({ eligible: false, reason: "WALLET_MISMATCH" });
    expect(canSign({ ...base, connectedPubkey: null }, NOW)).toEqual({
      eligible: false,
      reason: "WALLET_NOT_CONNECTED",
    });
    expect(canSign({ ...base, buildSender: null }, NOW)).toEqual({
      eligible: false,
      reason: "WALLET_MISMATCH",
    });
  });
});

describe("signing expiry gate (Codex P1 PR #13)", () => {
  it("blocks signing past the intent expiry", () => {
    expect(
      canSign(base, new Date("2030-01-01T00:15:00.001Z"))
    ).toEqual({ eligible: false, reason: "INTENT_EXPIRED" });
    expect(canSign(base, NOW)).toEqual({ eligible: true });
  });

  it("allows builds without a carried expiry (legacy staged state)", () => {
    expect(canSign({ ...base, expiresAt: null }, NOW)).toEqual({
      eligible: true,
    });
  });
});

describe("isUserRejection (Qodo 6 + Codex P2 PR #13)", () => {
  it("recognizes documented rejection shapes only", () => {
    expect(isUserRejection(new Error("User rejected the request"))).toBe(true);
    expect(isUserRejection({ code: 4001, message: "rejected" })).toBe(true);
    expect(isUserRejection(new Error("user denied signing"))).toBe(true);
    expect(isUserRejection(new Error("Action rejected"))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });

  it("routes operational failures to error, not rejection", () => {
    // Phantom wraps ALL provider faults in WalletSignTransactionError —
    // class alone must never imply rejection.
    expect(isUserRejection(new Error("Extension disconnected"))).toBe(false);
    expect(
      isUserRejection(new Error("Transaction simulation failed"))
    ).toBe(false);
    expect(isUserRejection(new Error("Network request failed"))).toBe(false);
  });
});

describe("verifySignedTransaction (Qodo 2 PR #13)", () => {
  // NOTE: ephemeral test-only keypair — never ships. The shipped-code gate
  // greps non-test sources for key material.
  const buildUnsigned = () => {
    const kp = Keypair.generate();
    const tx = new Transaction();
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
    tx.add({
      keys: [],
      programId: kp.publicKey,
      data: Buffer.from([0]),
    });
    return { kp, unsigned: bytesToBase64(tx.serialize({ requireAllSignatures: false })) };
  };

  it("accepts a genuine signature on the reviewed message", () => {
    const { kp, unsigned } = buildUnsigned();
    const tx = Transaction.from(base64ToBytes(unsigned));
    tx.partialSign(kp);
    const signed = bytesToBase64(tx.serialize());
    expect(
      verifySignedTransaction(unsigned, signed, kp.publicKey.toBase58())
    ).toBe(true);
  });

  it("rejects substituted messages, foreign signers, and unsigned payloads", () => {
    const { kp, unsigned } = buildUnsigned();
    const other = Keypair.generate();
    const tx = Transaction.from(base64ToBytes(unsigned));
    tx.partialSign(kp);
    const signed = bytesToBase64(tx.serialize());
    // Wrong expected signer.
    expect(
      verifySignedTransaction(unsigned, signed, other.publicKey.toBase58())
    ).toBe(false);
    // Unsigned payload presented as signed.
    expect(
      verifySignedTransaction(unsigned, unsigned, kp.publicKey.toBase58())
    ).toBe(false);
    // Garbage inputs.
    expect(verifySignedTransaction("!!!", signed, kp.publicKey.toBase58())).toBe(false);
    // Message substitution: sign a different message, present with original.
    const other2 = Keypair.generate();
    const tx2 = new Transaction();
    tx2.feePayer = other2.publicKey;
    tx2.recentBlockhash = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
    tx2.add({ keys: [], programId: other2.publicKey, data: Buffer.from([1]) });
    tx2.partialSign(other2);
    expect(
      verifySignedTransaction(
        unsigned,
        bytesToBase64(tx2.serialize()),
        other2.publicKey.toBase58()
      )
    ).toBe(false);
  });
});
