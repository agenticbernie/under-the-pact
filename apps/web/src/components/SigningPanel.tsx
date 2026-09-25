import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  WalletSignTransactionError,
} from "@solana/wallet-adapter-base";
import { Transaction } from "@solana/web3.js";
import { canSign } from "../lib/signing.js";

interface BuiltTx {
  intentId: string;
  sender: string;
  transaction: string;
}

type Phase =
  | { state: "idle" }
  | { state: "ready"; built: BuiltTx }
  | { state: "signing"; built: BuiltTx }
  | {
      state: "signed";
      built: BuiltTx;
      signedTransaction: string;
      signer: string;
    }
  | { state: "rejected" }
  | { state: "error"; message: string };

const emitSigned = (intentId: string, sender: string, signedTransaction: string) => {
  window.dispatchEvent(
    new CustomEvent("pact:signed", { detail: { intentId, sender, signedTransaction } })
  );
};

/**
 * BER-141: wallet signing flow (client-only island).
 * The wallet popup signs a user-reviewed unsigned transaction; Pact never
 * sees a private key — only the signed bytes (for BER-142 submission) or
 * a rejection. Signing stays impossible until confirmation + preflight +
 * build all line up on the same intent, wallet, and sender (canSign gate
 * re-checked at click time, not just render time).
 */
export function SigningPanel() {
  const { publicKey, connected, signTransaction } = useWallet();
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [preflight, setPreflight] = useState<{
    ok: boolean;
    intentId: string | null;
  }>({ ok: false, intentId: null });
  const generation = useRef(0);

  useEffect(() => {
    const onBuilt = (e: Event) => {
      const detail = (e as CustomEvent<BuiltTx>).detail;
      generation.current++;
      setPhase({ state: "ready", built: detail });
    };
    const onPreflight = (e: Event) => {
      const detail = (e as CustomEvent<{ ok: boolean; intentId: string | null }>).detail;
      setPreflight({ ok: detail.ok, intentId: detail.intentId });
      // A failed preflight retires any staged signing state.
      if (!detail.ok) {
        generation.current++;
        setPhase({ state: "idle" });
      }
    };
    const onReset = () => {
      generation.current++;
      setPhase({ state: "idle" });
      setPreflight({ ok: false, intentId: null });
    };
    window.addEventListener("pact:built", onBuilt);
    window.addEventListener("pact:preflight", onPreflight);
    window.addEventListener("pact:reset", onReset);
    return () => {
      generation.current++;
      window.removeEventListener("pact:built", onBuilt);
      window.removeEventListener("pact:preflight", onPreflight);
      window.removeEventListener("pact:reset", onReset);
    };
  }, []);

  if (phase.state === "idle") {
    return null;
  }

  const walletPubkey = connected && publicKey ? publicKey.toBase58() : null;

  const requestSign = () => {
    void (async () => {
      if (phase.state !== "ready") {
        return;
      }
      const { built } = phase;
      // Re-verify eligibility at click time with the live wallet.
      const gate = canSign({
        intentId: built.intentId,
        preflightOk: preflight.ok,
        preflightIntentId: preflight.intentId,
        connectedPubkey: walletPubkey,
        buildSender: built.sender,
        buildIntentId: built.intentId,
        hasUnsignedTx: true,
      });
      if (!gate.eligible) {
        setPhase({ state: "idle" });
        return;
      }
      const myGen = ++generation.current;
      const alive = () => generation.current === myGen;
      setPhase({ state: "signing", built });
      try {
        if (typeof signTransaction !== "function") {
          throw new Error("Wallet does not support transaction signing.");
        }
        const tx = Transaction.from(Buffer.from(built.transaction, "base64"));
        // Popup opens here. Private keys never leave the wallet;
        // only the signed bytes (or a rejection) come back.
        const signed = await signTransaction(tx);
        if (!alive()) {
          return;
        }
        const hasSignature =
          signed.signatures.some((s) => s.signature !== null);
        if (!hasSignature) {
          throw new Error("Wallet returned an unsigned transaction.");
        }
        const signedB64 = Buffer.from(
          signed.serialize({ requireAllSignatures: false })
        ).toString("base64");
        const signer = walletPubkey ?? "";
        setPhase({ state: "signed", built, signedTransaction: signedB64, signer });
        emitSigned(built.intentId, built.sender, signedB64);
      } catch (err) {
        if (!alive()) {
          return;
        }
        // User rejection is a safe terminal state: nothing signed,
        // nothing submitted, no payment exists.
        const rejected =
          err instanceof WalletSignTransactionError ||
          /reject|cancel|denied|dismiss/i.test(
            err instanceof Error ? err.message : String(err)
          );
        if (rejected) {
          setPhase({ state: "rejected" });
        } else {
          setPhase({
            state: "error",
            message: err instanceof Error ? err.message.slice(0, 200) : "Signing failed.",
          });
        }
      }
    })();
  };

  if (phase.state === "signing") {
    return (
      <div className="card" aria-live="polite">
        <h3>5. Wallet signing (BER-141)</h3>
        <p>Confirm the transaction in your wallet popup…</p>
      </div>
    );
  }

  if (phase.state === "signed") {
    return (
      <div className="card" aria-live="polite">
        <h3>5. Signed (BER-141)</h3>
        <p>
          ✅ Signed by <code title={phase.signer}>{phase.signer.slice(0, 4)}…{phase.signer.slice(-4)}</code>.
          Ready to submit — submission lands in BER-142. Nothing submitted yet.
        </p>
      </div>
    );
  }

  if (phase.state === "rejected") {
    return (
      <div className="card" aria-live="polite">
        <h3>5. Wallet signing (BER-141)</h3>
        <p role="alert">
          Rejected in wallet — no payment was made and nothing was submitted.
          Review the summary and try again, or cancel the payment.
        </p>
      </div>
    );
  }

  if (phase.state === "error") {
    return (
      <div className="card" aria-live="polite">
        <h3>5. Wallet signing (BER-141)</h3>
        <p role="alert">Signing failed: {phase.message}</p>
      </div>
    );
  }

  // ready
  const gate = canSign({
    intentId: phase.built.intentId,
    preflightOk: preflight.ok,
    preflightIntentId: preflight.intentId,
    connectedPubkey: walletPubkey,
    buildSender: phase.built.sender,
    buildIntentId: phase.built.intentId,
    hasUnsignedTx: true,
  });
  return (
    <div className="card" aria-live="polite">
      <h3>5. Wallet signing (BER-141)</h3>
      <p className="hint">
        Review the unsigned transaction above. Signing opens your wallet —
        approve it there. Pact never sees your private key.
      </p>
      <button onClick={requestSign} disabled={!gate.eligible}>
        Sign in wallet
      </button>
      {!gate.eligible && (
        <p className="hint">Sign unlocks after confirmation, preflight, and build line up.</p>
      )}
    </div>
  );
}
