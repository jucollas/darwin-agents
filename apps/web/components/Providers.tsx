"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { hashkeyTestnet } from "@/lib/chain";

/**
 * Login, and the wallet it hands the user.
 *
 * Email gets an embedded wallet made for them, so someone can fund a campaign from a laptop
 * with no extension installed and no seed phrase to write down. An existing wallet still
 * works for anyone who has one.
 *
 * With no NEXT_PUBLIC_PRIVY_APP_ID the provider is skipped entirely and the app runs the way
 * it did before accounts existed: one shared campaign, no login. That keeps `npm run dev`
 * working for anyone who has not set Privy up.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <>{children}</>;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
        // The agents live on HashKey, so the user's wallet has to be there to fund them.
        defaultChain: hashkeyTestnet,
        supportedChains: [hashkeyTestnet],
        appearance: {
          walletChainType: "ethereum-only",
          logo: undefined,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
