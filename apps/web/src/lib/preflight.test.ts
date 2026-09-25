import { describe, expect, it } from "vitest";
import {
  evaluatePreflight,
  MIN_SOL_LAMPORTS,
  resolveRunNetwork,
  type PreflightInput,
} from "./preflight.js";

const balances = {
  solLamports: 10_000_000,
  usdcMicro: 10_000_000,
  usdcAccountMissing: false,
  rpcFailed: false,
} as const;

const base: PreflightInput = {
  connected: true,
  networkCheck: { status: "matched" },
  balances: { ...balances },
  amountMicroUsdc: 5_000_000,
};

const codesOf = (input: PreflightInput): string[] | "OK" => {
  const result = evaluatePreflight(input);
  if (result.ok) {
    return "OK";
  }
  return result.issues.map((i) => i.code);
};

describe("preflight evaluation (BER-139)", () => {
  it("passes when everything is sufficient", () => {
    expect(evaluatePreflight(base)).toEqual({ ok: true });
  });

  it("requires a connected wallet first", () => {
    expect(codesOf({ ...base, connected: false })).toEqual([
      "WALLET_NOT_CONNECTED",
    ]);
  });

  it("emits WRONG_NETWORK only on a verified mismatch", () => {
    expect(
      codesOf({ ...base, networkCheck: { status: "mismatched" } })
    ).toContain("WRONG_NETWORK");
  });

  it("emits RPC_UNREACHABLE (not WRONG_NETWORK) on unknown network", () => {
    const codes = codesOf({ ...base, networkCheck: { status: "unknown" } });
    expect(codes).toContain("RPC_UNREACHABLE");
    expect(codes).not.toContain("WRONG_NETWORK");
  });

  it("detects null balances as RPC failure", () => {
    expect(codesOf({ ...base, balances: null })).toEqual(["RPC_UNREACHABLE"]);
  });

  it("rpcFailed suppresses amount judgments (unknown, not insufficient)", () => {
    const codes = codesOf({
      ...base,
      balances: { solLamports: null, usdcMicro: null, usdcAccountMissing: false, rpcFailed: true },
    });
    expect(codes).toEqual(["RPC_UNREACHABLE"]);
  });

  it("detects insufficient SOL at the exact boundary", () => {
    expect(
      codesOf({
        ...base,
        balances: { ...balances, solLamports: MIN_SOL_LAMPORTS },
      })
    ).toBe("OK");
    expect(
      codesOf({
        ...base,
        balances: { ...balances, solLamports: MIN_SOL_LAMPORTS - 1 },
      })
    ).toContain("INSUFFICIENT_SOL");
  });

  it("detects confirmed-missing vs insufficient USDC", () => {
    expect(
      codesOf({
        ...base,
        balances: { ...balances, usdcMicro: null, usdcAccountMissing: true },
      })
    ).toEqual(["NO_USDC_ACCOUNT"]);
    expect(
      codesOf({
        ...base,
        balances: { ...balances, usdcMicro: 4_999_999 },
      })
    ).toContain("INSUFFICIENT_USDC");
  });

  it("collects independent issues together", () => {
    const codes = codesOf({
      ...base,
      networkCheck: { status: "mismatched" },
      balances: { solLamports: 0, usdcMicro: null, usdcAccountMissing: true, rpcFailed: false },
    });
    expect(codes).toContain("WRONG_NETWORK");
    expect(codes).toContain("INSUFFICIENT_SOL");
    expect(codes).toContain("NO_USDC_ACCOUNT");
  });
});

describe("resolveRunNetwork (Qodo 1 + Codex P1)", () => {
  it("uses the approved intent network when configs agree", () => {
    expect(resolveRunNetwork("devnet", "devnet")).toEqual({
      ok: true,
      network: "devnet",
    });
  });

  it("fails on unsupported intent networks", () => {
    expect(resolveRunNetwork("mainnet", "mainnet")).toEqual({
      ok: false,
      reason: "unsupported-intent",
    });
  });

  it("fails when frontend config disagrees with the intent", () => {
    expect(resolveRunNetwork("devnet", "mainnet-beta")).toEqual({
      ok: false,
      reason: "config-mismatch",
    });
  });
});
