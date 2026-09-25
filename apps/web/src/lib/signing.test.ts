import { describe, expect, it } from "vitest";
import { canSign, type SigningState } from "./signing.js";

const base: SigningState = {
  intentId: "intent_1",
  preflightOk: true,
  preflightIntentId: "intent_1",
  connectedPubkey: "Wallet111111111111111111111111111111111111",
  buildSender: "Wallet111111111111111111111111111111111111",
  buildIntentId: "intent_1",
  hasUnsignedTx: true,
};

describe("signing gate (BER-141)", () => {
  it("allows signing only when everything lines up", () => {
    expect(canSign(base)).toEqual({ eligible: true });
  });

  it("blocks without intent, stale/failed preflight, or missing build", () => {
    expect(canSign({ ...base, intentId: null }).eligible).toBe(false);
    expect(
      canSign({ ...base, preflightIntentId: "intent_2" })
    ).toEqual({ eligible: false, reason: "STALE_PREFLIGHT" });
    expect(
      canSign({ ...base, preflightOk: false, preflightIntentId: "intent_1" })
    ).toEqual({ eligible: false, reason: "PREFLIGHT_NOT_OK" });
    expect(canSign({ ...base, hasUnsignedTx: false }).eligible).toBe(false);
    expect(
      canSign({ ...base, buildIntentId: "intent_2" })
    ).toEqual({ eligible: false, reason: "NO_UNSIGNED_TX" });
  });

  it("blocks wallet mismatch or disconnect", () => {
    expect(
      canSign({ ...base, connectedPubkey: "Other11111111111111111111111111111111" })
    ).toEqual({ eligible: false, reason: "WALLET_MISMATCH" });
    expect(canSign({ ...base, connectedPubkey: null })).toEqual({
      eligible: false,
      reason: "WALLET_NOT_CONNECTED",
    });
    expect(canSign({ ...base, buildSender: null })).toEqual({
      eligible: false,
      reason: "WALLET_MISMATCH",
    });
  });
});
