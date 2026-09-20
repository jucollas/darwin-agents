"use client";

import { useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
} from "viem";
import { agentTreasuryAbi, mockUSDAbi } from "@/lib/abi";
import { hashkeyTestnet } from "@/lib/chain";
import { AUTH_ENABLED } from "@/lib/useApi";

/**
 * Where the money comes from.
 *
 * The user signs the transfer into AgentTreasury with their own wallet, so the budget the
 * agents spend is visibly theirs and not a number the server made up. `fund()` is open to
 * anyone, so this works both to start a campaign and to top one up while it is running —
 * which is the difference between a population that dies when the pot empties and one that
 * keeps going once its strategies start paying.
 *
 * Three signatures, in order: mint test dollars if they have none, approve the treasury,
 * then fund. Each is a real transaction the user approves.
 */

type Props = {
  campaignId: string | null;
  treasury: string;
  token: string;
  onFunded: () => void;
};

type Phase = "idle" | "minting" | "approving" | "funding" | "done";

export function FundPanel(props: Props) {
  if (!AUTH_ENABLED) return null;
  return <Panel {...props} />;
}

function Panel({ campaignId, treasury, token, onFunded }: Props) {
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];

  const [amount, setAmount] = useState(50);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const publicClient = createPublicClient({
    chain: hashkeyTestnet,
    transport: http(),
  });

  /** What the user has to spend, in mUSD. */
  const readBalance = useCallback(async () => {
    if (!wallet) return;
    try {
      const raw = (await publicClient.readContract({
        address: token as Address,
        abi: mockUSDAbi,
        functionName: "balanceOf",
        args: [wallet.address as Address],
      })) as bigint;
      setBalance(Number(raw) / 1_000_000);
    } catch {
      setBalance(null);
    }
  }, [wallet, token]);

  useEffect(() => {
    readBalance();
  }, [readBalance]);

  async function fund() {
    if (!wallet || !campaignId) return;
    setError(null);
    const micro = BigInt(Math.round(amount * 1_000_000));

    try {
      const provider = await wallet.getEthereumProvider();
      const walletClient = createWalletClient({
        account: wallet.address as Address,
        chain: hashkeyTestnet,
        transport: custom(provider),
      });

      // The wallet has to be on HashKey before any of this signs.
      await wallet.switchChain(hashkeyTestnet.id);

      // 1 — test dollars, if they have none. MockUSD's faucet is open by design.
      const held = (await publicClient.readContract({
        address: token as Address,
        abi: mockUSDAbi,
        functionName: "balanceOf",
        args: [wallet.address as Address],
      })) as bigint;

      if (held < micro) {
        setPhase("minting");
        const mint = await walletClient.writeContract({
          address: token as Address,
          abi: mockUSDAbi,
          functionName: "mint",
          args: [wallet.address as Address, micro - held],
          chain: hashkeyTestnet,
          account: wallet.address as Address,
        });
        await publicClient.waitForTransactionReceipt({ hash: mint });
      }

      // 2 — let the treasury pull exactly this much.
      setPhase("approving");
      const approve = await walletClient.writeContract({
        address: token as Address,
        abi: mockUSDAbi,
        functionName: "approve",
        args: [treasury as Address, micro],
        chain: hashkeyTestnet,
        account: wallet.address as Address,
      });
      await publicClient.waitForTransactionReceipt({ hash: approve });

      // 3 — the money moves, signed by the user.
      setPhase("funding");
      const funded = await walletClient.writeContract({
        address: treasury as Address,
        abi: agentTreasuryAbi,
        functionName: "fund",
        args: [BigInt(campaignId), micro],
        chain: hashkeyTestnet,
        account: wallet.address as Address,
      });
      await publicClient.waitForTransactionReceipt({ hash: funded });

      setLastTx(funded);
      setPhase("done");
      await readBalance();
      onFunded();
    } catch (e) {
      setError(reason(e));
      setPhase("idle");
    }
  }

  if (!wallet) return null;

  const busy = phase !== "idle" && phase !== "done";

  return (
    <section
      className="band"
      style={{ paddingTop: "1.5rem", marginTop: "1.5rem" }}
    >
      <h2 style={{ fontSize: "1.25rem" }}>Put money in</h2>
      <p
        style={{
          color: "var(--ink-soft)",
          marginTop: "0.5rem",
          maxWidth: "62ch",
        }}
      >
        You sign this yourself, from{" "}
        <span className="tnum">
          {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
        </span>
        . The agents can only reach it through the treasury, and whatever they
        do not spend is still yours. Add more at any point — a population that
        found something that works can keep going instead of running dry.
      </p>

      <div
        style={{
          display: "flex",
          gap: "0.6rem",
          alignItems: "center",
          flexWrap: "wrap",
          marginTop: "1rem",
        }}
      >
        <input
          type="number"
          min={1}
          step={10}
          value={amount}
          disabled={busy}
          onChange={(e) => setAmount(Number(e.currentTarget.value))}
          className="tnum"
          style={{ width: 120 }}
          aria-label="Amount in test dollars to add"
        />
        <button
          type="button"
          className="press press-solid"
          disabled={busy || !campaignId || amount <= 0}
          onClick={fund}
        >
          {phase === "minting"
            ? "Getting test dollars…"
            : phase === "approving"
              ? "Approving…"
              : phase === "funding"
                ? "Sending…"
                : "Add to the budget"}
        </button>

        {balance !== null && (
          <span className="tnum" style={{ color: "var(--ink-faint)", fontSize: 13 }}>
            wallet holds ${balance.toFixed(2)} mUSD
          </span>
        )}
      </div>

      {!campaignId && (
        <p style={{ color: "var(--ink-faint)", fontSize: 13, marginTop: "0.6rem" }}>
          The campaign is funded on chain the first time a day settles. Run a day
          first, then you can top it up from here.
        </p>
      )}

      {lastTx && phase === "done" && (
        <p style={{ fontSize: 13, marginTop: "0.75rem" }}>
          <a
            href={`${hashkeyTestnet.blockExplorers.default.url}/tx/${lastTx}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--ledger)" }}
          >
            See the deposit on the explorer ↗
          </a>
        </p>
      )}

      {error && (
        <p role="alert" style={{ color: "var(--dead)", marginTop: "0.75rem" }}>
          {error}
        </p>
      )}
    </section>
  );
}

/** One readable line out of a wallet error, instead of the whole RPC payload. */
function reason(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  if (/User rejected|denied/i.test(message)) return "You cancelled that one.";
  if (/insufficient funds/i.test(message))
    return "Not enough HSK in the wallet to pay gas on HashKey testnet.";
  return message.split("\n")[0];
}
