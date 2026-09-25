/**
 * BER-139 / C-008: wallet/network/balance preflight (pure logic).
 *
 * Runs client-side before any signing step: failed preflight prevents
 * transaction creation and signing. These checks are UX/cost gates —
 * deterministic server policy (BER-134/135) and wallet signing remain
 * the trust boundaries. Pure function of fetched balances: fully tested
 * without RPC. Creates no transactions (reads only).
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

export interface PreflightBalances {
  /** null when the RPC read failed. */
  solLamports: number | null;
  /** null when no USDC associated token account exists (or read failed). */
  usdcMicro: number | null;
  usdcAccountMissing: boolean;
}

export interface PreflightInput {
  connected: boolean;
  /** Wallet cluster alignment already verified (genesis probe). */
  networkOk: boolean;
  /** Balances were actually read (vs RPC failure / account missing). */
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
  if (!input.networkOk) {
    issues.push({
      code: "WRONG_NETWORK",
      message:
        "Wallet network does not match the payment network — switch Phantom to the selected cluster and retry.",
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

  const { solLamports, usdcMicro, usdcAccountMissing } = input.balances;
  if (solLamports === null || solLamports < MIN_SOL_LAMPORTS) {
    issues.push({
      code: "INSUFFICIENT_SOL",
      message: `Need at least ${formatSol(MIN_SOL_LAMPORTS)} SOL for fees${
        solLamports === null ? "" : ` (wallet has ${formatSol(solLamports)} SOL)`
      }. Faucet devnet SOL and retry.`,
    });
  }
  if (usdcAccountMissing || usdcMicro === null) {
    issues.push({
      code: "NO_USDC_ACCOUNT",
      message:
        "No USDC token account found for this wallet — receive devnet USDC first (faucet), then retry.",
    });
  } else if (usdcMicro < input.amountMicroUsdc) {
    issues.push({
      code: "INSUFFICIENT_USDC",
      message: "USDC balance is below the payment amount — top up and retry.",
    });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
};
