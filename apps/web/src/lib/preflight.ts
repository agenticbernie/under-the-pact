import type { SolanaNetworkName } from "./wallet.js";

/**
 * BER-139 / C-008: wallet/network/balance preflight (pure logic).
 *
 * Runs client-side before any signing step: failed preflight prevents
 * transaction creation and signing. These checks are UX/cost gates —
 * deterministic server policy (BER-134/135) and wallet signing remain
 * the trust boundaries. Pure function of fetched data: fully tested
 * without RPC. Creates no transactions (reads only).
 *
 * Failure taxonomy (Qodo/Codex PR #11): unknown is never misreported —
 * an unverified network or a failed RPC read yields RPC_UNREACHABLE
 * (retry guidance), never WRONG_NETWORK / NO_USDC_ACCOUNT.
 */

export const MIN_SOL_LAMPORTS = 5_000_000; // 0.005 SOL: fees + ATA-rent buffer
export const LAMPORTS_PER_SOL = 1_000_000_000;

export type PreflightCode =
  | "WALLET_NOT_CONNECTED"
  | "WRONG_NETWORK"
  | "RPC_UNREACHABLE"
  | "INSUFFICIENT_SOL"
  | "NO_USDC_ACCOUNT"
  | "INSUFFICIENT_USDC";

/** Wallet cluster vs the policy-approved intent network. */
export type NetworkCheck =
  | { status: "matched" }
  | { status: "mismatched" }
  | { status: "unknown" };

export interface PreflightBalances {
  /** null when the SOL read failed (pairs with rpcFailed). */
  solLamports: number | null;
  /** null unless a confirmed balance was read. */
  usdcMicro: number | null;
  /** true ONLY when getAccountInfo returned null (confirmed absence). */
  usdcAccountMissing: boolean;
  /** true when any transport/RPC read failed. */
  rpcFailed: boolean;
}

export interface PreflightInput {
  connected: boolean;
  networkCheck: NetworkCheck;
  balances: PreflightBalances | null;
  amountMicroUsdc: number;
}

export interface PreflightIssue {
  code: PreflightCode;
  message: string;
}

export type PreflightResult = { ok: true } | { ok: false; issues: PreflightIssue[] };

export const formatSol = (lamports: number): string =>
  (lamports / LAMPORTS_PER_SOL).toFixed(4);

/**
 * Which network governs this run: always the policy-approved intent
 * network, never frontend config alone. Frontend/backend disagreement or
 * an unsupported intent network fails explicitly (Qodo 1 + Codex P1).
 */
export const resolveRunNetwork = (
  intentNetwork: string,
  frontendNetwork: string
):
  | { ok: true; network: SolanaNetworkName }
  | { ok: false; reason: "unsupported-intent" | "config-mismatch" } => {
  const known: SolanaNetworkName[] = ["devnet", "testnet", "mainnet-beta"];
  if (!(known as string[]).includes(intentNetwork)) {
    return { ok: false, reason: "unsupported-intent" };
  }
  if (frontendNetwork !== intentNetwork) {
    return { ok: false, reason: "config-mismatch" };
  }
  return { ok: true, network: intentNetwork as SolanaNetworkName };
};

export const evaluatePreflight = (input: PreflightInput): PreflightResult => {
  const issues: PreflightIssue[] = [];

  if (!input.connected) {
    return {
      ok: false,
      issues: [
        {
          code: "WALLET_NOT_CONNECTED",
          message: "Connect Phantom to run preflight checks.",
        },
      ],
    };
  }

  if (input.networkCheck.status === "mismatched") {
    issues.push({
      code: "WRONG_NETWORK",
      message:
        "Wallet cluster does not match the approved payment network — switch Phantom to the selected cluster and retry.",
    });
  } else if (input.networkCheck.status === "unknown") {
    issues.push({
      code: "RPC_UNREACHABLE",
      message:
        "Could not verify the wallet network — the endpoint did not answer. Retry before paying.",
    });
  }

  if (input.balances === null) {
    issues.push({
      code: "RPC_UNREACHABLE",
      message:
        "Could not read balances from the RPC endpoint. Check the connection and retry.",
    });
    return { ok: false, issues };
  }

  const { solLamports, usdcMicro, usdcAccountMissing, rpcFailed } =
    input.balances;
  if (rpcFailed) {
    // A failed read is unknown, never insufficient: report retry guidance
    // once and skip amount judgments that would misblame balances.
    if (!issues.some((i) => i.code === "RPC_UNREACHABLE")) {
      issues.push({
        code: "RPC_UNREACHABLE",
        message:
          "A balance read failed — retry. Balances are unknown, not insufficient.",
      });
    }
    return { ok: false, issues };
  }

  if (solLamports === null || solLamports < MIN_SOL_LAMPORTS) {
    issues.push({
      code: "INSUFFICIENT_SOL",
      message: `Need at least ${formatSol(MIN_SOL_LAMPORTS)} SOL for fees${
        solLamports === null ? "" : ` (wallet has ${formatSol(solLamports)} SOL)`
      }. Faucet devnet SOL and retry.`,
    });
  }
  if (usdcAccountMissing) {
    issues.push({
      code: "NO_USDC_ACCOUNT",
      message:
        "No USDC token account found for this wallet — receive devnet USDC first (faucet), then retry.",
    });
  } else if (usdcMicro === null || usdcMicro < input.amountMicroUsdc) {
    issues.push({
      code: "INSUFFICIENT_USDC",
      message: "USDC balance is below the payment amount — top up and retry.",
    });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
};
