import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  evaluatePreflight,
  resolveRunNetwork,
  type NetworkCheck,
  type PreflightBalances,
  type PreflightIssue,
  type PreflightResult,
} from "../lib/preflight.js";
import { genesisMatchesNetwork } from "../lib/wallet.js";

interface ConfirmedIntentView {
  intentId: string;
  amountMicroUsdc: number;
  tokenMint: string;
  network: string;
}

interface PreflightEvent {
  ok: boolean;
  intentId: string | null;
  pubkey: string;
  codes: string[];
}

type Phase =
  | { state: "idle" }
  | { state: "checking"; intentId: string }
  | { state: "done"; intentId: string; result: PreflightResult; pubkey: string };

const emit = (detail: PreflightEvent) => {
  window.dispatchEvent(new CustomEvent("pact:preflight", { detail }));
};

/**
 * BER-139 / C-008: preflight checks after CONFIRMED (client-side reads).
 * Authority order: the sealed intent's network governs (never frontend
 * config alone); genesis mismatches block; probe/RPC failures report
 * RPC_UNREACHABLE, never WRONG_NETWORK / NO_USDC_ACCOUNT. Reads only —
 * failed preflight blocks signing (BER-141 gates on pact:preflight).
 * Stale runs are discarded by generation guard; every event carries the
 * intent ID so gates bind results to the authorized payment.
 */
export function PreflightPanel({ network }: { network: string }) {
  const { connection } = useConnection();
  const { wallet, publicKey, connected } = useWallet();
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const generation = useRef(0);
  const storedIntent = useRef<ConfirmedIntentView | null>(null);
  const walletKey = publicKey?.toBase58() ?? null;

  const run = useCallback(
    async (intent: ConfirmedIntentView) => {
      const myGen = ++generation.current;
      const alive = () => generation.current === myGen;
      storedIntent.current = intent;
      setPhase({ state: "checking", intentId: intent.intentId });

      const fail = (
        result: PreflightResult,
        pubkey: string,
        codes: string[]
      ) => {
        if (!alive()) {
          return;
        }
        setPhase({ state: "done", intentId: intent.intentId, result, pubkey });
        emit({ ok: false, intentId: intent.intentId, pubkey, codes });
      };

      try {
        // 1. The approved intent network governs (Qodo 1 + Codex P1).
        const resolved = resolveRunNetwork(intent.network, network);
        if (!resolved.ok) {
          const issue: PreflightIssue =
            resolved.reason === "unsupported-intent"
              ? {
                  code: "WRONG_NETWORK",
                  message: `Approved intent targets unsupported network “${intent.network}”.`,
                }
              : {
                  code: "WRONG_NETWORK",
                  message: `Frontend targets ${network} but the approved intent is for ${intent.network} — align configuration before paying.`,
                };
          fail({ ok: false, issues: [issue] }, "", ["WRONG_NETWORK"]);
          return;
        }

        if (!connected || !publicKey) {
          fail(
            {
              ok: false,
              issues: [
                {
                  code: "WALLET_NOT_CONNECTED",
                  message: "Connect Phantom to run preflight checks.",
                },
              ],
            },
            "",
            ["WALLET_NOT_CONNECTED"]
          );
          return;
        }
        const key = publicKey;

        // 2. Genesis probe: matched / mismatched / probe-failed (unknown).
        let networkCheck: NetworkCheck;
        try {
          const hash = await connection.getGenesisHash();
          if (!alive()) {
            return;
          }
          networkCheck = genesisMatchesNetwork(resolved.network, hash)
            ? { status: "matched" }
            : { status: "mismatched" };
        } catch {
          if (!alive()) {
            return;
          }
          networkCheck = { status: "unknown" };
        }

        // 3. Balances: confirmed absence (accountInfo null) vs RPC failure.
        let balances: PreflightBalances | null = null;
        try {
          const solLamports = await connection.getBalance(key);
          if (!alive()) {
            return;
          }
          const mint = new PublicKey(intent.tokenMint);
          const ata = await getAssociatedTokenAddress(
            mint,
            key,
            false,
            TOKEN_PROGRAM_ID
          );
          const info = await connection.getAccountInfo(ata);
          if (!alive()) {
            return;
          }
          if (info === null) {
            balances = {
              solLamports,
              usdcMicro: null,
              usdcAccountMissing: true,
              rpcFailed: false,
            };
          } else {
            const bal = await connection.getTokenAccountBalance(ata);
            if (!alive()) {
              return;
            }
            balances = {
              solLamports,
              usdcMicro: Number(BigInt(bal.value.amount)),
              usdcAccountMissing: false,
              rpcFailed: false,
            };
          }
        } catch {
          if (!alive()) {
            return;
          }
          // Transport/rate-limit failure: unknown balances, never
          // misreported as missing account or insufficient funds.
          balances = {
            solLamports: null,
            usdcMicro: null,
            usdcAccountMissing: false,
            rpcFailed: true,
          };
        }

        const result = evaluatePreflight({
          connected: true,
          walletName: wallet?.adapter?.name ?? null,
          networkCheck,
          balances,
          amountMicroUsdc: intent.amountMicroUsdc,
        });
        if (!alive()) {
          return;
        }
        const pubkey = key.toBase58();
        setPhase({ state: "done", intentId: intent.intentId, result, pubkey });
        emit({
          ok: result.ok,
          intentId: intent.intentId,
          pubkey,
          codes:
            result.ok === false
              ? result.issues.map((i: PreflightIssue) => i.code)
              : [],
        });
      } catch {
        // Unexpected failure still publishes a correlated terminal result
        // (Qodo 6) so gates never wait on a dead run.
        if (!alive()) {
          return;
        }
        const pubkey = publicKey?.toBase58() ?? "";
        const result: PreflightResult = {
          ok: false,
          issues: [
            {
              code: "RPC_UNREACHABLE",
              message: "Preflight failed unexpectedly — retry.",
            },
          ],
        };
        setPhase({ state: "done", intentId: intent.intentId, result, pubkey });
        emit({
          ok: false,
          intentId: intent.intentId,
          pubkey,
          codes: ["RPC_UNREACHABLE"],
        });
      }
    },
    [connected, connection, network, publicKey]
  );

  // pact:confirmed starts a run; pact:reset retires everything.
  useEffect(() => {
    const onConfirmed = (e: Event) => {
      void run((e as CustomEvent<ConfirmedIntentView>).detail);
    };
    const onReset = () => {
      generation.current++;
      storedIntent.current = null;
      setPhase({ state: "idle" });
    };
    window.addEventListener("pact:confirmed", onConfirmed);
    window.addEventListener("pact:reset", onReset);
    return () => {
      generation.current++;
      window.removeEventListener("pact:confirmed", onConfirmed);
      window.removeEventListener("pact:reset", onReset);
    };
  }, [run]);

  // Wallet change invalidates the displayed result (Codex P1): disconnect
  // revokes with an explicit event; a new account reruns the stored intent.
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastKey.current === walletKey) {
      return;
    }
    lastKey.current = walletKey;
    if (phase.state === "idle") {
      return;
    }
    if (walletKey === null) {
      generation.current++;
      const intentId = storedIntent.current?.intentId ?? null;
      setPhase({ state: "idle" });
      emit({ ok: false, intentId, pubkey: "", codes: ["WALLET_NOT_CONNECTED"] });
    } else if (storedIntent.current !== null) {
      void run(storedIntent.current);
    }
  }, [walletKey]);

  if (phase.state === "idle") {
    return null;
  }
  if (phase.state === "checking") {
    return (
      <div className="card" aria-live="polite">
        <h3>3. Preflight checks (BER-139)</h3>
        <p>Reading wallet network and balances…</p>
      </div>
    );
  }
  const { result, pubkey } = phase;
  const retry = storedIntent.current;
  return (
    <div className="card" aria-live="polite">
      <h3>3. Preflight checks (BER-139)</h3>
      {result.ok === true ? (
        <p>
          ✅ Ready — wallet {pubkey.slice(0, 4)}…{pubkey.slice(-4)} holds
          enough SOL for fees and enough USDC. No transaction created yet.
        </p>
      ) : (
        <div>
          <p role="alert">
            ⛔ Preflight failed — no transaction will be created or signed
            until these are resolved:
          </p>
          <ul>
            {result.issues.map((i) => (
              <li key={i.code}>
                <code>{i.code}</code>: {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {retry !== null && (
        <button onClick={() => void run(retry)}>
          Re-check readiness
        </button>
      )}
    </div>
  );
}
