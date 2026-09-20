"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChainFlow } from "./ChainFlow";
import { FundPanel } from "./FundPanel";
import { LineageStrip } from "./LineageStrip";
import { MoneyLedger } from "./MoneyLedger";
import { PopulationTable } from "./PopulationTable";
import {
  type LedgerEntry,
  readNdjson,
  toLedgerEntry,
} from "@/lib/ledger";
import { useApi } from "@/lib/useApi";
import { type CampaignView, money, percent } from "@/lib/view";

type ChainStatus =
  | { configured: false }
  | {
      configured: true;
      chainId: number;
      name: string;
      explorer: string | null;
      treasury: string;
    };

export function Dashboard() {
  const [campaign, setCampaign] = useState<CampaignView | null>(null);
  const [chain, setChain] = useState<ChainStatus>({ configured: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  /**
   * Autoplay is what turns the population into something to watch rather than click.
   * While the speaker is talking, days pass, agents die and children are born on screen.
   */
  const [running, setRunning] = useState(false);
  /** Every money movement of this session, newest first. */
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [settling, setSettling] = useState(false);
  const [chainName, setChainName] = useState<string | null>(null);
  const router = useRouter();
  const api = useApi();
  // Guards against a slow day overlapping the next one and queueing requests up. A day
  // that settles on chain can take half a minute, so this matters more than it used to.
  const ticking = useRef(false);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const res = await api("/api/campaign", { cache: "no-store" });
    const data = await res.json();
    setCampaign(data.campaign);
    setChain(data.chain);
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Run one day and stream its money as it settles.
   *
   * Every payment is a real transaction when the chain is configured, so a day takes as
   * long as the network takes. Rather than block until it is over, each movement is pushed
   * onto the ledger the moment the node confirms it.
   */
  const runDay = useCallback(async () => {
    if (ticking.current) return;
    ticking.current = true;
    try {
      const res = await api("/api/tick?ticks=1", { method: "POST" });
      if (!res.body) return;

      await readNdjson(res.body, (message) => {
        if (message.type === "start") {
          setSettling(Boolean(message.settling));
          setChainName((message.chain as string | null) ?? null);
        }
        const row = toLedgerEntry(message, seq.current++);
        if (row) setLedger((prev) => [row, ...prev].slice(0, 200));
        if (message.type === "error") setError(String(message.message));
      });

      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      ticking.current = false;
    }
  }, [refresh, api]);

  // Autoplay: start the next day only once the previous one has fully settled, so the
  // clock follows the chain rather than racing ahead of it.
  useEffect(() => {
    if (!running) return;
    let stop = false;
    (async () => {
      while (!stop) {
        await runDay();
        if (stop) break;
        // A breath between days so the ledger is readable rather than a blur.
        await new Promise((r) => setTimeout(r, 600));
      }
    })();
    return () => {
      stop = true;
    };
  }, [running, runDay]);

  // A paused campaign delivers nothing, so keep the button honest and stop the clock.
  useEffect(() => {
    if (campaign?.paused) setRunning(false);
  }, [campaign?.paused]);

  const act = useCallback(
    async (label: string, run: () => Promise<Response>) => {
      setBusy(label);
      setError(null);
      try {
        const res = await run();
        if (!res.ok)
          setError(
            (await res.json().catch(() => ({})))?.error ?? "That did not work.",
          );
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  if (!campaign) {
    return (
      <main style={{ maxWidth: 640, margin: "0 auto", padding: "4rem 1rem" }}>
        <h1 style={{ fontSize: "2rem" }}>No campaign running</h1>
        <p style={{ color: "var(--ink-soft)", marginTop: "0.75rem" }}>
          Set up a product and a budget, and the first generation of agents
          starts trading.
        </p>
        <a
          href="/"
          className="press press-solid"
          style={{ display: "inline-block", marginTop: "1.5rem" }}
        >
          Set up a campaign
        </a>
      </main>
    );
  }

  const champion = campaign.agents.find((a) => a.isChampion) ?? null;

  return (
    <main style={{ maxWidth: 1020, margin: "0 auto", padding: "0 1rem 5rem" }}>
      <header style={{ paddingTop: "2.5rem", paddingBottom: "1.5rem" }}>
        <p style={{ color: "var(--ink-faint)", fontSize: 13, margin: 0 }}>
          Selling {campaign.productName} at ${campaign.priceUsd.toFixed(0)} ·
          day {campaign.tick} · generation {campaign.generation}
        </p>
        <h1
          style={{
            fontSize: "clamp(1.8rem, 4.5vw, 2.6rem)",
            marginTop: "0.4rem",
            maxWidth: "20ch",
          }}
        >
          {campaign.alive} agents are spending real money
        </h1>
      </header>

      {/* The numbers that decide who gets to spend, and nothing else. */}
      <section
        className="band"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "1.5rem",
          padding: "1.25rem 0",
        }}
      >
        <Figure
          label="Spent"
          value={money(campaign.spentUsd)}
          note={`ceiling ${money(campaign.globalCapUsd)}`}
        />
        <Figure
          label="Earned"
          value={money(campaign.revenueUsd)}
          note={`${campaign.conversions} sales`}
        />
        <Figure
          label="Profit"
          value={money(campaign.profitUsd, true)}
          note={
            campaign.spentUsd > 0
              ? `${percent(campaign.roi)} return`
              : "nothing spent yet"
          }
          tone={campaign.profitUsd >= 0 ? "alive" : "dead"}
        />
        <Figure
          label="Best earner"
          value={champion ? champion.label : "—"}
          note={champion ? `on ${champion.genome.platform}` : "nobody is up yet"}
          tone="sulfur"
        />
      </section>

      {error && (
        <p
          role="alert"
          style={{
            color: "var(--dead)",
            borderLeft: "2px solid var(--dead)",
            paddingLeft: "0.75rem",
            margin: "1rem 0",
          }}
        >
          {error}
        </p>
      )}

      {/* The main event. */}
      <section className="band" style={{ paddingTop: "1.75rem" }}>
        <ChainFlow chain={chain} campaign={campaign} onDone={refresh} />
      </section>

      {chain.configured && (
        <FundPanel
          campaignId={campaign.chain.campaignId}
          treasury={chain.treasury}
          token={campaign.chain.token ?? ""}
          onFunded={refresh}
        />
      )}

      {/* Everything below explains where that agent came from. */}
      <section className="band" style={{ marginTop: "3rem", paddingTop: "1.75rem" }}>
        <h2 style={{ fontSize: "1.4rem" }}>The money, day by day</h2>
        <p
          style={{
            color: "var(--ink-soft)",
            marginTop: "0.5rem",
            maxWidth: "62ch",
          }}
        >
          Every payment below is signed by the agent that made it and settled on
          chain before the next one starts. Nobody chose these strategies:{" "}
          {campaign.total} agents have been created, {campaign.dead} were shut
          down for spending more than they earned, and the survivors inherited
          what was left.
        </p>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.6rem",
            alignItems: "center",
            padding: "1.25rem 0",
          }}
        >
          <button
            type="button"
            className="press press-solid"
            disabled={busy !== null || campaign.paused}
            onClick={() => setRunning((r) => !r)}
            style={
              running
                ? { background: "var(--dead)", borderColor: "var(--dead)" }
                : undefined
            }
          >
            {running ? "■ Stop the clock" : "▶ Run the days"}
          </button>
          <button
            type="button"
            className="press"
            disabled={busy !== null || campaign.paused || running}
            onClick={runDay}
          >
            One day
          </button>
          <button
            type="button"
            className="press"
            disabled={busy !== null}
            onClick={() =>
              act("pause", () =>
                api("/api/control", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    action: campaign.paused ? "resume" : "pause",
                  }),
                }),
              )
            }
          >
            {campaign.paused ? "Resume" : "Freeze everything"}
          </button>
          {/* Back to setup with a clean slate. endCampaign() drops the whole session, so
              the next campaign shares no agents, metrics or events with this one. */}
          <button
            type="button"
            className="press"
            disabled={busy !== null}
            style={{ marginLeft: "auto" }}
            onClick={() => {
              setRunning(false);
              act("new", async () => {
                const res = await api("/api/campaign", { method: "DELETE" });
                router.push("/");
                router.refresh();
                return res;
              });
            }}
          >
            + New campaign
          </button>
        </div>

        {campaign.paused && (
          <p style={{ color: "var(--dead)", margin: "0 0 1rem" }}>
            Every agent is frozen. On chain this is the same owner-only pause
            that makes <code>spend()</code> revert.
          </p>
        )}

        <MoneyLedger
          entries={ledger}
          running={running || ticking.current}
          settling={settling}
          chainName={chainName}
        />

        <div style={{ marginTop: "2rem" }}>
          <LineageStrip
            agents={campaign.agents}
            generation={campaign.generation}
            selectedId={hovered}
            onSelect={setHovered}
          />
        </div>
      </section>

      <details style={{ marginTop: "2rem" }}>
        <summary
          style={{
            cursor: "pointer",
            color: "var(--ink-soft)",
            padding: "0.75rem 0",
            borderTop: "1px solid var(--rule)",
          }}
        >
          Every agent, line by line ({campaign.alive} trading, {campaign.dead}{" "}
          shut down)
        </summary>
        <PopulationTable
          agents={campaign.agents}
          hovered={hovered}
          onHover={setHovered}
          busy={busy !== null}
          explorer={chain.configured ? chain.explorer : null}
          onKill={(agentId) =>
            act("kill", () =>
              api("/api/control", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "kill", agentId }),
              }),
            )
          }
        />
      </details>

      <details style={{ marginTop: "0.5rem" }}>
        <summary
          style={{
            cursor: "pointer",
            color: "var(--ink-soft)",
            padding: "0.75rem 0",
            borderTop: "1px solid var(--rule)",
          }}
        >
          What happened, day by day
        </summary>
        <ol style={{ listStyle: "none", margin: "0.5rem 0 0", padding: 0 }}>
          {campaign.events.map((event, i) => (
            <li
              key={`${event.at}-${i}`}
              className="hairline"
              style={{
                display: "flex",
                gap: "1rem",
                padding: "0.5rem 0",
                fontSize: 14,
              }}
            >
              <span
                className="tnum"
                style={{ color: "var(--ink-faint)", minWidth: "3.5rem" }}
              >
                day {event.tick}
              </span>
              <span
                style={{
                  color:
                    event.kind === "death"
                      ? "var(--dead)"
                      : event.kind === "birth"
                        ? "var(--alive)"
                        : event.kind === "chain"
                          ? "var(--ledger)"
                          : "var(--ink)",
                }}
              >
                {event.message}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </main>
  );
}

function Figure({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "alive" | "dead" | "sulfur";
}) {
  const color = tone ? `var(--${tone})` : "var(--ink)";
  return (
    <div>
      <div style={{ color: "var(--ink-faint)", fontSize: 13 }}>{label}</div>
      <div
        className="tnum"
        style={{
          fontSize: "1.5rem",
          color,
          marginTop: "0.2rem",
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      <div
        style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: "0.15rem" }}
      >
        {note}
      </div>
    </div>
  );
}
