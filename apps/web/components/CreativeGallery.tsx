"use client";

import { useState } from "react";
import { type AgentView, money, percent } from "@/lib/view";

/**
 * What the agents actually wrote, side by side.
 *
 * The rest of the dashboard argues that the population is learning by showing numbers.
 * This is the part a juror can read without trusting us: six agents were handed the same
 * product and the same brief, and they came back with visibly different ads. The palette
 * comes from tone, the layout from content type, and the copy from the model — so a card
 * that looks and sounds different is a strategy that *is* different.
 *
 * Ads are ordered by profit, because the interesting question is not "what did they say"
 * but "what did the winner say that the corpse did not".
 */

type Props = {
  agents: AgentView[];
  productImage: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
};

type Published = {
  agent: AgentView;
  creative: AgentView["creatives"][number];
};

export function CreativeGallery({
  agents,
  productImage,
  selectedId,
  onSelect,
}: Props) {
  const [showDead, setShowDead] = useState(false);

  // Newest publication per agent: an agent that survived several generations has written
  // more than one, and the current one is what it is betting on now.
  const published: Published[] = agents
    .map((agent) => {
      const creative = agent.creatives[agent.creatives.length - 1];
      return creative ? { agent, creative } : null;
    })
    .filter((x): x is Published => x !== null);

  const living = published.filter((p) => p.agent.status === "alive");
  const dead = published.filter((p) => p.agent.status === "dead");
  const shown = showDead ? [...living, ...dead] : living;

  const ordered = [...shown].sort((a, b) => {
    if (a.agent.status !== b.agent.status)
      return a.agent.status === "alive" ? -1 : 1;
    return b.agent.profitUsd - a.agent.profitUsd;
  });

  if (published.length === 0) return null;

  const anyFromModel = published.some((p) => p.creative.source === "llm");

  return (
    <section className="band" style={{ paddingTop: "1.75rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ fontSize: "1.25rem" }}>What the agents are saying</h2>
        {dead.length > 0 && (
          <button
            type="button"
            onClick={() => setShowDead((v) => !v)}
            style={{
              background: "none",
              border: "none",
              color: "var(--ink-soft)",
              cursor: "pointer",
              fontSize: "0.85rem",
              padding: 0,
            }}
          >
            {showDead
              ? "Only the ones still trading"
              : `Show the ${dead.length} that were shut down`}
          </button>
        )}
      </div>

      <p
        style={{
          color: "var(--ink-soft)",
          margin: "0.5rem 0 0",
          maxWidth: "62ch",
          fontSize: "0.9rem",
        }}
      >
        Same product, same brief. Each agent wrote its own ad from its own
        strategy — the colours come from its tone, the layout from its content
        type.{" "}
        {anyFromModel
          ? "Copy written by the configured model."
          : "No model configured, so these are the deterministic fallbacks."}{" "}
        Sorted by profit, best first.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: "1.25rem",
          marginTop: "1.5rem",
        }}
      >
        {ordered.map(({ agent, creative }) => {
          const isSelected = selectedId === agent.id;
          const isDead = agent.status === "dead";
          // The uploaded product photo wins when there is one, exactly as it would in a
          // real ad; the rendered SVG is the fallback that still shows the strategy.
          const art = creative.imageRef ?? productImage ?? creative.visual;

          return (
            <article
              key={`${agent.id}-${creative.tick}`}
              onMouseEnter={() => onSelect(agent.id)}
              onMouseLeave={() => onSelect(null)}
              style={{
                border: `1px solid ${isSelected ? "var(--accent, #6b66d1)" : "var(--rule)"}`,
                borderRadius: 8,
                overflow: "hidden",
                opacity: isDead ? 0.55 : 1,
                transition: "opacity 120ms, border-color 120ms",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {art && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={art}
                  alt={`Ad by agent ${agent.id}: ${creative.headline}`}
                  style={{
                    width: "100%",
                    aspectRatio: "8 / 5",
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              )}

              <div
                style={{
                  padding: "0.9rem 1rem 1rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                  flex: 1,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: "0.5rem",
                  }}
                >
                  <strong style={{ fontSize: "0.95rem" }}>
                    {agent.id}
                    {agent.isChampion && (
                      <span
                        style={{
                          color: "var(--good, #4ade80)",
                          fontWeight: 400,
                          fontSize: "0.8rem",
                        }}
                      >
                        {" "}
                        · best
                      </span>
                    )}
                  </strong>
                  <span
                    style={{
                      fontSize: "0.8rem",
                      color:
                        agent.profitUsd >= 0
                          ? "var(--good, #4ade80)"
                          : "var(--bad, #f87171)",
                    }}
                  >
                    {agent.profitUsd >= 0 ? "+" : ""}
                    {money(agent.profitUsd)} · {percent(agent.roi)}
                  </span>
                </div>

                <p style={{ margin: 0, fontWeight: 600, lineHeight: 1.3 }}>
                  {creative.headline}
                </p>
                <p
                  style={{
                    margin: 0,
                    color: "var(--ink-soft)",
                    fontSize: "0.88rem",
                    lineHeight: 1.45,
                  }}
                >
                  {creative.body}
                </p>

                <div
                  style={{
                    marginTop: "auto",
                    paddingTop: "0.6rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      border: "1px solid var(--rule)",
                      borderRadius: 999,
                      padding: "0.2rem 0.7rem",
                      fontSize: "0.78rem",
                    }}
                  >
                    {creative.cta}
                  </span>
                  <span
                    style={{ fontSize: "0.75rem", color: "var(--ink-soft)" }}
                  >
                    {agent.genome.contentType.replace(/_/g, " ")} ·{" "}
                    {agent.genome.tone} · {agent.genome.audience.replace(/_/g, " ")}
                  </span>
                </div>

                <div
                  style={{
                    fontSize: "0.72rem",
                    color: "var(--ink-soft)",
                    display: "flex",
                    gap: "0.5rem",
                    flexWrap: "wrap",
                  }}
                >
                  <span>
                    {creative.source === "llm"
                      ? "written by the model"
                      : "template fallback"}
                  </span>
                  <span>· day {creative.tick}</span>
                  {creative.mood && <span>· {creative.mood}</span>}
                  {isDead && agent.deathReason && (
                    <span>· shut down: {agent.deathReason}</span>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
