import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Connection } from "@solana/web3.js";
import { shortWallet } from "../lib/format.js";
import {
  genesisMatchesNetwork,
  isKnownNetwork,
  isSupportedWallet,
  resolveRpcEndpoint,
  type NetworkVerification,
  type SolanaNetworkName,
} from "../lib/wallet.js";
import { WalletProviders } from "./WalletProviders.js";
import { PreflightPanel } from "./PreflightPanel.js";

/**
 * BER-138: connection panel (mounted client:only — wallets need window).
 * States: misconfigured network | unsupported wallet | disconnected |
 * connecting | connected (address + disconnect). No signing here.
 *
 * Two independent verifications gate nothing but inform everything:
 *  - RPC cluster: genesis hash probed from the endpoint must match the
 *    selected network (Qodo PR #10 — an override pointing at mainnet
 *    blocks the wallet UI: real-money risk).
 *  - Backend policy network: explicit loading/verified/error tri-state
 *    (Qodo PR #10 — failures are shown, never treated as a match).
 */
function Panel({
  apiUrl,
  network,
  endpoint,
}: {
  apiUrl: string;
  network: string;
  endpoint: string;
}) {
  const { wallet, publicKey, connecting, connected, disconnect, select } =
    useWallet();
  const [backend, setBackend] = useState<NetworkVerification>({
    state: "loading",
  });
  const [clusterOk, setClusterOk] = useState<
    "checking" | "ok" | "mismatch" | "error"
  >("checking");

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiUrl}/api/merchant`)
      .then((r) => {
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((j) => {
        if (cancelled) {
          return;
        }
        const net = (j as { merchant?: { network?: unknown } })?.merchant
          ?.network;
        setBackend(
          typeof net === "string" && net.length > 0
            ? { state: "verified", backendNetwork: net }
            : { state: "error" }
        );
      })
      .catch(() => {
        if (!cancelled) {
          setBackend({ state: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  useEffect(() => {
    let cancelled = false;
    if (!isKnownNetwork(network)) {
      return;
    }
    new Connection(endpoint)
      .getGenesisHash()
      .then((hash) => {
        if (!cancelled) {
          setClusterOk(genesisMatchesNetwork(network, hash) ? "ok" : "mismatch");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setClusterOk("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, network]);

  if (!isKnownNetwork(network)) {
    return (
      <p role="alert">
        Unsupported network “{network}”. Set PUBLIC_SOLANA_NETWORK to devnet,
        testnet, or mainnet-beta.
      </p>
    );
  }

  if (clusterOk === "mismatch") {
    return (
      <p role="alert">
        RPC endpoint serves a different Solana cluster than {network} — wallet
        connection is disabled. Check PUBLIC_SOLANA_RPC_URL.
      </p>
    );
  }

  const walletName = wallet?.adapter?.name ?? null;
  if (connected && !isSupportedWallet(walletName)) {
    return (
      <div>
        <p role="alert">
          Unsupported wallet “{walletName ?? "unknown"}” — this demo supports
          Phantom only.
        </p>
        <button
          onClick={() => {
            // Clear the selection too: disconnect() alone leaves the
            // unsupported adapter selected, trapping the user in a
            // reconnect loop instead of reopening wallet choice (Codex P2).
            void disconnect();
            select(null);
          }}
        >
          Disconnect
        </button>
      </div>
    );
  }

  const mismatch =
    backend.state === "verified" && backend.backendNetwork !== network;
  return (
    <div>
      <WalletMultiButton disabled={clusterOk !== "ok"} />
      {clusterOk === "checking" && <p className="hint">Verifying RPC cluster…</p>}
      {clusterOk === "error" && (
        <p role="alert">
          Could not verify the RPC cluster — connection stays available but
          confirm the endpoint serves {network} before paying.
        </p>
      )}
      {connecting && <p>Connecting to wallet…</p>}
      {connected && publicKey && (
        <p>
          Connected: <code title={publicKey.toBase58()}>
            {shortWallet(publicKey.toBase58())}
          </code>{" "}
          on Solana {network}
        </p>
      )}
      {!connected && !connecting && (
        <p className="hint">Connect Phantom to continue (demo: switch it to {network}).</p>
      )}
      {backend.state === "loading" && (
        <p className="hint">Verifying backend policy network…</p>
      )}
      {backend.state === "error" && (
        <p role="alert">
          Backend network unverified — the policy check could not run.
          Proceed only if the backend is reachable.
        </p>
      )}
      {mismatch && backend.state === "verified" && (
        <p role="alert">
          Network mismatch: wallet UI targets {network} but the backend policy
          uses {backend.backendNetwork}. Align PUBLIC_SOLANA_NETWORK with the
          backend.
        </p>
      )}
    </div>
  );
}

/**
 * Single island entry: providers + panel. Imported with client:only="react".
 */
export function WalletRoot({
  apiUrl,
  network,
  rpcOverride,
}: {
  apiUrl: string;
  network: string;
  rpcOverride: string;
}) {
  const net: SolanaNetworkName = isKnownNetwork(network) ? network : "devnet";
  const endpoint = resolveRpcEndpoint(net, rpcOverride);
  return (
    <WalletProviders endpoint={endpoint}>
      <Panel apiUrl={apiUrl} network={network} endpoint={endpoint} />
      <PreflightPanel network={network} />
    </WalletProviders>
  );
}
