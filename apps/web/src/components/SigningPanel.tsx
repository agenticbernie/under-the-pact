import { Buffer } from "buffer";
import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { base64ToBytes, bytesToBase64 } from "../lib/base64.js";
import {
  canSign,
  isUserRejection,
  verifySignedTransaction,
} from "../lib/signing.js";

// web3.js uses the Node Buffer API internally; the deployed Astro browser
// runtime has no such global (Qodo 3 + Codex P1 PR #13), so install the
// `buffer` package polyfill at this island entry. App code itself uses
// the Web-API helpers in lib/base64 (no Buffer references of its own).
if (
  typeof (globalThis as Record<string, unknown>)["Buffer"] === "undefined"
) {
  (globalThis as Record<string, unknown>)["Buffer"] = Buffer;
}

interface BuiltTx {
  intentId: string;
  sender: string;
  transaction: string;
  /** Intent expiry carried for the signing gate (null only for legacy). */
  expiry: string | null;
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
  | { state: "rejected"; built: BuiltTx }
  | { state: "error"; built: BuiltTx; message: string };

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
 * build all line up on the same intent, wallet, sender, and freshness
 * (canSign gate re-checked at click time, not just render time).
 */
export function SigningPanel() {
  const { publicKey, connected, signTransaction } = useWallet();
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [preflight, setPreflight] = useState<{
    ok: boolean;
    intentId: string | null;
  }>({ ok: false, intentId: null });
  const generation = useRef(0);
  const walletKey = publicKey?.toBase58() ?? null;
  const walletKeyRef = useRef<string | null>(null);
  walletKeyRef.current = walletKey;

  // Any wallet change retires staged/signed state (Qodo 1+4, Codex P2):
  // a pending popup or old bytes must never resolve against the new account.
  const lastWallet = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastWallet.current === undefined) {
      lastWallet.current = walletKey;
      return;
    }
    if (lastWallet.current !== walletKey) {
      lastWallet.current = walletKey;
      generation.current++;
      setPhase({ state: "idle" });
    }
  }, [walletKey]);

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

  // The signing operation, callable from Sign AND from retry buttons
  // (Qodo/Codex PR #16: retry must reopen the wallet directly, not land
  // back on an intermediate card requiring a second click).
  const attemptSign = (built: BuiltTx) => {
    void (async () => {
      // Re-verify eligibility at click time with the live wallet.
      const gate = canSign({
        intentId: built.intentId,
        expiresAt: built.expiry,
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
        const tx = Transaction.from(base64ToBytes(built.transaction));
        // Popup opens here. Private keys never leave the wallet;
        // only the signed bytes (or a rejection) come back.
        const signed = await signTransaction(tx);
        if (!alive()) {
          return;
        }
        // Re-check the live key: an account switch during the popup
        // invalidates this result even if the adapter resolved (Codex P2).
        const liveKey = walletKeyRef.current;
        if (liveKey === null || liveKey !== built.sender) {
          setPhase({ state: "idle" });
          return;
        }
        // Approve only a genuine signature by the expected key over the
        // exact reviewed message (Qodo 2): substituted or foreign-signed
        // payloads become errors, never pact:signed.
        const signedB64 = bytesToBase64(
          signed.serialize({ requireAllSignatures: false })
        );
        if (!verifySignedTransaction(built.transaction, signedB64, built.sender)) {
          throw new Error("Wallet returned an invalid signature.");
        }
        setPhase({ state: "signed", built, signedTransaction: signedB64, signer: liveKey });
        emitSigned(built.intentId, built.sender, signedB64);
      } catch (err) {
        if (!alive()) {
          return;
        }
        // Rejection is proven by code/message — the generic
        // WalletSignTransactionError wraps ALL provider faults, so its
        // class alone never implies rejection (Qodo 6 + Codex P2).
        // Both carry the staged build so signing can be retried (Qodo PR #15).
        if (isUserRejection(err)) {
          setPhase({ state: "rejected", built });
        } else {
          setPhase({
            state: "error",
            built,
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
    // Retryable: the staged build is preserved (Qodo PR #15) — rejecting
    // signs nothing, so trying again is always safe. Re-runs the live
    // eligibility gate rather than assuming anything.
    const retryGate = canSign({
      intentId: phase.built.intentId,
      expiresAt: phase.built.expiry,
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
        <p role="alert">
          Rejected in wallet — no payment was made and nothing was submitted.
          Review the summary and try again, or cancel the payment.
        </p>
        <button
          onClick={() => attemptSign(phase.built)}
          disabled={!retryGate.eligible}
        >
          Try signing again
        </button>
        {!retryGate.eligible && (
          <p className="hint">
            Reconnect the wallet and pass preflight to retry.
          </p>
        )}
      </div>
    );
  }

  if (phase.state === "error") {
    const retryGate = canSign({
      intentId: phase.built.intentId,
      expiresAt: phase.built.expiry,
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
        <p role="alert">Signing failed: {phase.message}</p>
        <button
          onClick={() => attemptSign(phase.built)}
          disabled={!retryGate.eligible}
        >
          Try signing again
        </button>
        {!retryGate.eligible && (
          <p className="hint">
            Reconnect the wallet and pass preflight to retry.
          </p>
        )}
      </div>
    );
  }

  // ready
  const gate = canSign({
    intentId: phase.built.intentId,
    expiresAt: phase.built.expiry,
    preflightOk: preflight.ok,
    preflightIntentId: preflight.intentId,
    connectedPubkey: walletPubkey,
    buildSender: phase.built.sender,
    buildIntentId: phase.built.intentId,
    hasUnsignedTx: true,
  });
  const requestSign = () => {
    if (phase.state === "ready") {
      attemptSign(phase.built);
    }
  };
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
