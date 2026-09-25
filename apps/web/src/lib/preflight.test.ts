import { describe, expect, it } from "vitest";
import {
  evaluatePreflight,
  MIN_SOL_LAMPORTS,
  type PreflightInput,
} from "./preflight.js";

const base: PreflightInput = {
  connected: true,
  networkOk: true,
  balances: { solLamports: 10_000_000, usdcMicro: 10_000_000, usdcAccountMissing: false },
  amountMicroUsdc: 5_000_000,
};

describe("preflight evaluation (BER-139)", () => {
  it("passes when everything is sufficient", () => {
    expect(evaluatePreflight(base)).toEqual({ ok: true });
  });

  it("requires a connected wallet first", () => {
    const result = evaluatePreflight({ ...base, connected: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toEqual(["WALLET_NOT_CONNECTED"]);
    }
  });

  it("detects wrong network", () => {
    const result = evaluatePreflight({ ...base, networkOk: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === "WRONG_NETWORK")).toBe(true);
    }
  });

  it("detects unreachable RPC without blaming balances", () => {
    const result = evaluatePreflight({ ...base, balances: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toEqual(["RPC_UNREACHABLE"]);
    }
  });

  it("detects insufficient SOL at the exact boundary", () => {
    const exact = evaluatePreflight({
      ...base,
      balances: { ...base.balances!, solLamports: MIN_SOL_LAMPORTS, usdcMicro: 10_000_000, usdcAccountMissing: false },
    });
    expect(exact.ok).toBe(true);
    const short = evaluatePreflight({
      ...base,
      balances: { ...base.balances!, solLamports: MIN_SOL_LAMPORTS - 1, usdcMicro: 10_000_000, usdcAccountMissing: false },
    });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.issues.some((i) => i.code === "INSUFFICIENT_SOL")).toBe(true);
    }
  });

  it("detects missing USDC account and insufficient USDC", () => {
    const missing = evaluatePreflight({
      ...base,
      balances: { solLamports: 10_000_000, usdcMicro: null, usdcAccountMissing: true },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues.map((i) => i.code)).toEqual(["NO_USDC_ACCOUNT"]);
    }
    const short = evaluatePreflight({
      ...base,
      balances: { solLamports: 10_000_000, usdcMicro: 4_999_999, usdcAccountMissing: false },
    });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.issues.some((i) => i.code === "INSUFFICIENT_USDC")).toBe(true);
    }
  });

  it("collects independent issues together", () => {
    const result = evaluatePreflight({
      ...base,
      networkOk: false,
      balances: { solLamports: 0, usdcMicro: null, usdcAccountMissing: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((i) => i.code);
      expect(codes).toContain("WRONG_NETWORK");
      expect(codes).toContain("INSUFFICIENT_SOL");
      expect(codes).toContain("NO_USDC_ACCOUNT");
    }
  });
});
