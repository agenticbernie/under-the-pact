import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { formatMicroUsdc } from "../lib/format.js";
import {
  evaluatePreflight,
  type PreflightIssue,
  type PreflightResult,
} from "../lib/preflight.js";
import { genesisMatchesNetwork, type SolanaNetworkName } from "../lib/wallet.js";

interface ConfirmedIntentView {
  intentId: string;
  amountMicroUsdc: number;
  tokenMint: string;
  network: string;
}

type Phase =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "done"; result: PreflightResult; pubkey: string };

/**
 * BER-139 / C-008: preflight checks after CONFIRMED (client-side reads).
 * Listens for pact:confirmed (Astro flow posts the sealed CONFIRMED intent)
 * and pact:reset. Reads only — creates no transactions; failed preflight
 * blocks signing (BER-141 gates on the pact:preflight event + this UI).
 * Mint/amount come from the validated intent: same values policy approved.
 */
export function PreflightPanel({ network }: { network: string }) {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [phase, setPhase] = useState<Phase>({ state: "idle" });

  const run = useCallback(
    async (intent: ConfirmedIntentView) => {
      setPhase({ state: "checking" });
      try {
        const key = publicKey;
        if (!connected || !key) {
          const result = evaluatePreflight({
            connected: false,
            networkOk: true,
            balances: null,
            amountMicroUsdc: intent.amountMicroUsdc,
          });
          setPhase({ state: "done", result, pubkey: "" });
          window.dispatchEvent(
            new CustomEvent("pact:preflight", { detail: { ok: false } })
          );
          return;
        }
        // Wallet cluster must match the payment network (genesis probe).
        let networkOk = false;
        try {
          const hash = await connection.getGenesisHash();
          networkOk = genesisMatchesNetwork(
            network as SolanaNetworkName,
            hash
          );
        } catch {
          networkOk = false;
        }
        // Balances on OUR endpoint (same RPC the tx will use).
        let solLamports: number | null = null;
        let usdcMicro: number | null = null;
        let missing = false;
        try {
          solLamports = await connection.getBalance(key);
          const mint = new PublicKey(intent.tokenMint);
          const ata = await getAssociatedTokenAddress(
            mint,
            key,
            false,
            TOKEN_PROGRAM_ID
          );
          try {
            const bal = await connection.getTokenAccountBalance(ata);
            usdcMicro = Number(BigInt(bal.value.amount));
          } catch {
            missing = true;
          }
        } catch {
          // solLamports/usdcMicro stay null -> RPC_UNREACHABLE / NO_USDC.
        }
        const result = evaluatePreflight({
          connected: true,
          networkOk,
          balances:
            solLamports === null && usdcMicro === null && !missing
              ? null
              : { solLamports, usdcMicro, usdcAccountMissing: missing },
          amountMicroUsdc: intent.amountMicroUsdc,
        });
        setPhase({ state: "done", result, pubkey: key.toBase58() });
        window.dispatchEvent(
          new CustomEvent("pact:preflight", {
            detail: {
              ok: result.ok,
              pubkey: key.toBase58(),
              issues:
                result.ok === false
                  ? result.issues.map((i: PreflightIssue) => i.code)
                  : [],
            },
          })
        );
      } catch {
        const result: PreflightResult = {
          ok: false,
          issues: [
            {
              code: "RPC_UNREACHABLE",
              message: "Preflight failed unexpectedly — retry.",
            },
          ],
        };
        setPhase({ state: "done", result, pubkey: "" });
      }
    },
    [connected, connection, network, publicKey]
  );

  useEffect(() => {
    const onConfirmed = (e: Event) => {
      void run((e as CustomEvent<ConfirmedIntentView>).detail);
    };
    const onReset = () => setPhase({ state: "idle" });
    window.addEventListener("pact:confirmed", onConfirmed);
    window.addEventListener("pact:reset", onReset);
    return () => {
      window.removeEventListener("pact:confirmed", onConfirmed);
      window.removeEventListener("pact:reset", onReset);
    };
  }, [run]);

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
          <p className="hint">
            Balances shown in SOL: fee reserve and USDC are read from the
            payment network ({network}).
          </p>
        </div>
      )}
    </div>
  );
}
