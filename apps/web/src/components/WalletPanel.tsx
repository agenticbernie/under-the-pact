import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { shortWallet } from "../lib/format.js";
import {
  isKnownNetwork,
  isSupportedWallet,
  networksMatch,
  resolveRpcEndpoint,
  type SolanaNetworkName,
} from "../lib/wallet.js";
import { WalletProviders } from "./WalletProviders.js";

/**
 * BER-138: connection panel (mounted client:only — wallets need window).
 * States: misconfigured network | unsupported wallet | disconnected |
 * connecting | connected (address + disconnect). No signing here.
 */
function Panel({ apiUrl, network }: { apiUrl: string; network: string }) {
  const { wallet, publicKey, connecting, connected, disconnect } = useWallet();
  const [backendNetwork, setBackendNetwork] = useState<string | undefined>(
    undefined
  );

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiUrl}/api/merchant`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.merchant?.network) {
          setBackendNetwork(String(j.merchant.network));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  if (!isKnownNetwork(network)) {
    return (
      <p role="alert">
        Unsupported network “{network}”. Set PUBLIC_SOLANA_NETWORK to devnet,
        testnet, or mainnet-beta.
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
        <button onClick={() => void disconnect()}>Disconnect</button>
      </div>
    );
  }

  const mismatch =
    connected && !networksMatch(network, backendNetwork);
  return (
    <div>
      <WalletMultiButton />
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
      {mismatch && (
        <p role="alert">
          Network mismatch: wallet UI targets {network} but the backend policy
          uses {backendNetwork}. Align PUBLIC_SOLANA_NETWORK with the backend.
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
      <Panel apiUrl={apiUrl} network={network} />
    </WalletProviders>
  );
}
