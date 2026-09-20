"use client";

import { useCallback, useRef, useState } from "react";
import { useApi } from "@/lib/useApi";
import type { AgentView, CampaignView } from "@/lib/view";

/**
 * The main screen: one agent taken through the real sequence on a real chain, a step at a
 * time, with the wallet that signed each transaction and a link to it in the explorer.
 *
 * Every line here is something that actually happened on a network. The steps stream in as
 * they land rather than arriving together, because each one is a testnet round trip and the
 * waiting is part of what makes it legible as real.
 */

type ChainStatus =
  | { configured: false }
  | {
      configured: true;
      chainId: number;
      name: string;
      explorer: string | null;
      treasury: string;
    };

type Actor = "operator" | "agent" | "exchange" | "contract";

type Step = {
  step: string;
  detail: string;
  narrative: string;
  actor: Actor;
  txUrl?: string;
  txHash?: string;
  address?: string;
  ok: boolean;
};

type Header = {
  label: string;
  chain: string;
  treasury: string;
  treasuryUrl: string;
};

/** Who did the thing. The demo lives or dies on the audience tracking this. */
const ACTORS: Record<Actor, { who: string; color: string }> = {
  operator: { who: "the human", color: "var(--ink-soft)" },
  agent: { who: "the agent", color: "var(--alive)" },
  exchange: { who: "the ad exchange", color: "var(--sulfur)" },
  contract: { who: "the contract", color: "var(--ledger)" },
};

export function ChainFlow({
  chain,
  campaign,
  onDone,
}: {
  chain: ChainStatus;
  campaign: CampaignView;
  onDone: () => void;
}) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [header, setHeader] = useState<Header | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const api = useApi();

  const living = campaign.agents.filter((a) => a.status === "alive");
  const candidate =
    living.find((a) => a.id === picked) ??
    living.find((a) => a.isChampion) ??
    living[0] ??
    null;

  const run = useCallback(async () => {
    if (!candidate) return;
    setRunning(true);
    setFailed(null);
    setSteps([]);
    setHeader(null);

    const controller = new AbortController();
    abort.current = controller;

    try {
      const res = await api("/api/prove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: candidate.id }),
        signal: controller.signal,
      });

      // A config error still comes back as plain JSON rather than a stream.
      if (!res.body || !res.headers.get("content-type")?.includes("ndjson")) {
        const data = await res.json().catch(() => ({}));
        setFailed(data.error ?? "The run could not start.");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Newline-delimited JSON: hold the tail until its newline arrives, since a chunk
      // boundary can land in the middle of a record.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let cut = buffer.indexOf("\n");
        while (cut !== -1) {
          const line = buffer.slice(0, cut).trim();
          buffer = buffer.slice(cut + 1);
          cut = buffer.indexOf("\n");
          if (!line) continue;

          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }

          if (message.type === "start") {
            setHeader({
              label: String(message.label),
              chain: String(message.chain),
              treasury: String(message.treasury),
              treasuryUrl: String(message.treasuryUrl),
            });
          } else if (message.type === "step") {
            setSteps((prev) => [...prev, message.step as Step]);
          }
        }
      }
      onDone();
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        setFailed((e as Error).message);
    } finally {
      setRunning(false);
      abort.current = null;
    }
  }, [candidate, onDone, api]);

  if (!chain.configured) {
    return (
      <section style={{ paddingTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.4rem" }}>The chain is not wired up</h2>
        <p
          style={{
            color: "var(--ink-soft)",
            marginTop: "0.6rem",
            maxWidth: "62ch",
          }}
        >
          This screen shows real transactions or it shows nothing. Deploy the
          contracts, put their addresses in <code>.env</code>, and restart the
          server.
        </p>
      </section>
    );
  }

  return (
    <section style={{ paddingTop: "0.5rem" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-end",
          justifyContent: "space-between",
        }}
      >
        <div style={{ maxWidth: "58ch" }}>
          <h2 style={{ fontSize: "1.6rem" }}>
            One agent, spending its own money
          </h2>
          <p style={{ color: "var(--ink-soft)", marginTop: "0.5rem" }}>
            Six steps on {chain.name}. The agent holds its own key, pays an
            exchange that refuses to serve it for free, and then tries to spend
            past its limit so you can watch the contract say no.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
          {living.length > 1 && (
            <label style={{ display: "grid", gap: "0.25rem" }}>
              <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>
                Agent
              </span>
              <select
                value={candidate?.id ?? ""}
                disabled={running}
                onChange={(e) => setPicked(e.currentTarget.value)}
                style={{ width: "auto", minWidth: 190 }}
              >
                {living.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                    {a.isChampion ? " — best earner" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="press press-solid"
            disabled={running || !candidate}
            onClick={run}
          >
            {running ? "Running on chain…" : "Run it on chain"}
          </button>
        </div>
      </div>

      {candidate && <AgentCard agent={candidate} explorer={chain.explorer} />}

      {failed && (
        <p role="alert" style={{ color: "var(--dead)", marginTop: "1rem" }}>
          {failed}
        </p>
      )}

      {steps.length > 0 && (
        <ol style={{ listStyle: "none", margin: "1.75rem 0 0", padding: 0 }}>
          {steps.map((step, i) => (
            <StepRow key={`${step.step}-${i}`} step={step} n={i + 1} />
          ))}
        </ol>
      )}

      {running && (
        <p
          className="tnum"
          style={{
            color: "var(--ink-faint)",
            fontSize: 13,
            marginTop: "1rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <Pulse /> waiting for {chain.name} to confirm the next transaction…
        </p>
      )}

      {header && !running && (
        <p style={{ fontSize: 13, marginTop: "1.25rem" }}>
          <a href={header.treasuryUrl} target="_blank" rel="noreferrer">
            Open AgentTreasury in the explorer
          </a>{" "}
          <span style={{ color: "var(--ink-faint)" }}>
            — every transaction above is there, signed and timestamped.
          </span>
        </p>
      )}
    </section>
  );
}

/** Who is about to spend, and from which address. The audience needs both up front. */
function AgentCard({
  agent,
  explorer,
}: {
  agent: AgentView;
  explorer: string | null;
}) {
  return (
    <div
      style={{
        marginTop: "1.5rem",
        padding: "1rem 1.1rem",
        background: "var(--paper-sunk)",
        border: "1px solid var(--rule)",
        display: "flex",
        flexWrap: "wrap",
        gap: "1.5rem",
        alignItems: "baseline",
      }}
    >
      <div>
        <div style={{ color: "var(--ink-faint)", fontSize: 12 }}>Agent</div>
        <div style={{ fontSize: "1.1rem", marginTop: "0.15rem" }}>
          {agent.label}
          {agent.isChampion && (
            <span style={{ color: "var(--sulfur)", fontSize: 13 }}>
              {" "}
              · best earner
            </span>
          )}
        </div>
      </div>

      <div style={{ minWidth: "18ch" }}>
        <div style={{ color: "var(--ink-faint)", fontSize: 12 }}>
          Its wallet
        </div>
        <div style={{ marginTop: "0.15rem" }}>
          {agent.address ? (
            <Address address={agent.address} explorer={explorer} />
          ) : (
            <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>
              gets one in step 2
            </span>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: "22ch" }}>
        <div style={{ color: "var(--ink-faint)", fontSize: 12 }}>
          The strategy it is betting on
        </div>
        <div
          style={{ marginTop: "0.15rem", fontSize: 14, color: "var(--ink-soft)" }}
        >
          {agent.strategy}
        </div>
      </div>
    </div>
  );
}

function StepRow({ step, n }: { step: Step; n: number }) {
  const actor = ACTORS[step.actor];
  return (
    <li
      style={{
        display: "grid",
        gridTemplateColumns: "2rem 1fr",
        gap: "1rem",
        padding: "1.1rem 0",
        borderTop: "1px solid var(--rule)",
      }}
    >
      <div
        className="tnum"
        style={{
          color: step.ok ? actor.color : "var(--dead)",
          fontSize: 13,
          paddingTop: "0.15rem",
        }}
      >
        {step.ok ? String(n).padStart(2, "0") : "××"}
      </div>

      <div>
        <div
          style={{
            color: step.ok ? actor.color : "var(--dead)",
            fontSize: 12,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {actor.who}
        </div>

        <div style={{ fontSize: "1.05rem", marginTop: "0.15rem" }}>
          {step.step}
        </div>

        <p
          style={{
            color: "var(--ink-soft)",
            margin: "0.4rem 0 0",
            maxWidth: "68ch",
          }}
        >
          {step.narrative}
        </p>

        <div
          className="tnum"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.75rem",
            alignItems: "center",
            marginTop: "0.5rem",
            fontSize: 13,
            color: step.ok ? "var(--ink-faint)" : "var(--dead)",
          }}
        >
          <span>{step.detail}</span>
          {step.txHash && (
            <span style={{ color: "var(--ink-faint)" }}>
              tx {short(step.txHash)}
            </span>
          )}
          {step.txUrl && (
            <a
              href={step.txUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--ledger)" }}
            >
              see it on the explorer ↗
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

function Address({
  address,
  explorer,
}: {
  address: string;
  explorer: string | null;
}) {
  const label = (
    <span className="tnum" style={{ fontSize: 14 }}>
      {short(address)}
    </span>
  );
  if (!explorer) return label;
  return (
    <a
      href={`${explorer}/address/${address}`}
      target="_blank"
      rel="noreferrer"
      style={{ color: "var(--ledger)" }}
    >
      {label}
    </a>
  );
}

function short(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

function Pulse() {
  return (
    <svg width={9} height={9} aria-hidden="true">
      <circle cx={4.5} cy={4.5} r={4} fill="var(--ledger)">
        <animate
          attributeName="opacity"
          values="1;0.25;1"
          dur="1.3s"
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  );
}
