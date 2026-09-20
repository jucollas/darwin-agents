"use client";

import type { LedgerEntry } from "@/lib/ledger";

/**
 * Every movement of money, newest first, with the balance it changed and the transaction
 * that proves it. This is the answer to "where did the budget actually go" — not a summary
 * at the end, but each payment as it settles.
 */

/** A refusal moves no money, so it is rendered separately and never looked up here. */
const KIND: Record<
  Exclude<LedgerEntry["kind"], "refused">,
  { color: string; arrow: string; who: string }
> = {
  spend: { color: "var(--dead)", arrow: "→", who: "paid out" },
  revenue: { color: "var(--alive)", arrow: "←", who: "came in" },
  reproduce: { color: "var(--sulfur)", arrow: "⇢", who: "inherited" },
  kill: { color: "var(--ink-faint)", arrow: "×", who: "closed" },
};

export function MoneyLedger({
  entries,
  running,
  settling,
  chainName,
}: {
  entries: LedgerEntry[];
  running: boolean;
  settling: boolean;
  chainName: string | null;
}) {
  if (entries.length === 0 && !running) {
    return (
      <p style={{ color: "var(--ink-soft)", marginTop: "1rem" }}>
        {settling
          ? `Run a day and every payment will settle on ${chainName}, one transaction at a time.`
          : "Run a day to watch the agents trade. No chain is configured, so nothing here will settle."}
      </p>
    );
  }

  return (
    <div style={{ marginTop: "1rem" }}>
      {running && (
        <p
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            color: "var(--ink-faint)",
            fontSize: 13,
            margin: "0 0 0.75rem",
          }}
        >
          <Pulse />
          {settling
            ? `settling on ${chainName} — each line below is a confirmed transaction`
            : "trading…"}
        </p>
      )}

      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {entries.map((e) => (
          <Row key={e.key} entry={e} />
        ))}
      </ol>
    </div>
  );
}

function Row({ entry }: { entry: LedgerEntry }) {
  // A refusal is not a movement — it is the contract declining one, which is worth more
  // than the payment it blocked.
  if (entry.kind === "refused") {
    return (
      <li
        className="hairline"
        style={{ display: "grid", gap: "0.15rem", padding: "0.6rem 0" }}
      >
        <div
          style={{
            display: "flex",
            gap: "0.6rem",
            alignItems: "baseline",
            flexWrap: "wrap",
          }}
        >
          <span
            className="tnum"
            style={{ color: "var(--ink-faint)", fontSize: 12, minWidth: "3.2rem" }}
          >
            day {entry.tick}
          </span>
          <span style={{ color: "var(--ledger)" }}>
            the contract refused {entry.label}
          </span>
        </div>
        <div
          className="tnum"
          style={{
            color: "var(--ink-soft)",
            fontSize: 13,
            paddingLeft: "3.8rem",
          }}
        >
          asked for ${entry.amountUsd.toFixed(2)} — {entry.reason}
        </div>
      </li>
    );
  }

  const k = KIND[entry.kind];
  return (
    <li
      className="hairline"
      style={{ display: "grid", gap: "0.15rem", padding: "0.6rem 0" }}
    >
      <div
        style={{
          display: "flex",
          gap: "0.6rem",
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <span
          className="tnum"
          style={{ color: "var(--ink-faint)", fontSize: 12, minWidth: "3.2rem" }}
        >
          day {entry.tick}
        </span>
        <span>{entry.headline}</span>
        <span className="tnum" style={{ color: k.color }}>
          {entry.kind === "revenue" ? "+" : entry.kind === "spend" ? "−" : ""}$
          {entry.amountUsd.toFixed(2)}
        </span>
      </div>

      <div
        className="tnum"
        style={{
          display: "flex",
          gap: "0.6rem",
          alignItems: "baseline",
          flexWrap: "wrap",
          color: "var(--ink-faint)",
          fontSize: 13,
          paddingLeft: "3.8rem",
        }}
      >
        <span>
          ${entry.beforeUsd.toFixed(2)} {k.arrow} ${entry.afterUsd.toFixed(2)}
        </span>
        {entry.txUrl ? (
          <a
            href={entry.txUrl}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--ledger)" }}
          >
            tx ↗
          </a>
        ) : (
          <span style={{ color: "var(--ink-faint)" }}>not settled</span>
        )}
      </div>
    </li>
  );
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
