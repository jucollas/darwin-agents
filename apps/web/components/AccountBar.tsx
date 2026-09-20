"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/useApi";

/**
 * Who is signed in, and the wallet the money comes out of.
 *
 * The address is shown rather than hidden because it is the point: the budget the agents
 * spend leaves this wallet, and anyone watching can follow it into the treasury.
 */
export function AccountBar() {
  if (!AUTH_ENABLED) return null;
  return <Bar />;
}

function Bar() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const router = useRouter();

  const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
  const email = user?.email?.address ?? null;

  return (
    <div
      className="hairline"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: "0.9rem",
        padding: "0.55rem max(1rem, calc((100% - 1020px) / 2))",
        fontSize: 13,
        color: "var(--ink-soft)",
      }}
    >
      {!ready ? null : authenticated ? (
        <>
          {email && <span>{email}</span>}
          {wallet && (
            <span
              className="tnum"
              title={wallet.address}
              style={{ color: "var(--ledger)" }}
            >
              {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
            </span>
          )}
          <button
            type="button"
            className="press"
            style={{ padding: "0.3rem 0.7rem", fontSize: 13 }}
            onClick={async () => {
              await logout();
              router.push("/");
              router.refresh();
            }}
          >
            Sign out
          </button>
        </>
      ) : (
        <>
          <span>Sign in to run agents on your own budget.</span>
          <button
            type="button"
            className="press press-solid"
            style={{ padding: "0.3rem 0.8rem", fontSize: 13 }}
            onClick={login}
          >
            Sign in
          </button>
        </>
      )}
    </div>
  );
}
