import { useMemo, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * BER-138 / C-007: wallet provider tree (client-only island child).
 *
 * Exactly ONE supported wallet (Phantom). The adapter never exposes
 * private keys — Pact only ever sees the public key plus signing
 * methods (signing itself lands in BER-141; nothing signs here).
 */
export function WalletProviders({
  endpoint,
  children,
}: {
  endpoint: string;
  children: ReactNode;
}) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
