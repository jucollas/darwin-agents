/**
 * The client-side shape of a day's money movements.
 *
 * `/api/tick` streams these as they settle, so the browser never has to wait for a whole
 * day of transactions before it can show the first one.
 */

export type LedgerEntry =
  | {
      key: string;
      kind: "spend" | "revenue" | "reproduce" | "kill";
      agentId: string;
      label: string;
      headline: string;
      amountUsd: number;
      beforeUsd: number;
      afterUsd: number;
      tick: number;
      txUrl: string | null;
    }
  | {
      key: string;
      kind: "refused";
      agentId: string;
      label: string;
      amountUsd: number;
      reason: string;
      tick: number;
    };

export type TickStreamEvent =
  | { type: "start"; ticks: number; settling: boolean; chain: string | null; fromTick: number }
  | { type: "funded"; amountUsd: number; capUsd: number; txUrl: string | null }
  | { type: "registered"; agentId: string; label: string; address: string; txUrl: string | null }
  | { type: "day"; tick: number }
  | { type: "dayDone"; report: unknown }
  | { type: "entry" } & Record<string, unknown>
  | { type: "refused" } & Record<string, unknown>
  | { type: "done"; tick: number; generation: number }
  | { type: "error"; message: string };

/**
 * Read a newline-delimited JSON stream, handing each record to `onEvent`.
 *
 * A chunk boundary can land mid-record, so the tail is held back until its newline
 * arrives — parsing greedily here drops roughly one transaction per day on a slow link.
 */
export async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
      try {
        onEvent(JSON.parse(line));
      } catch {
        // A malformed line is not worth failing a run that is settling real money.
      }
    }
  }
}

/** Turn a streamed record into a ledger row, or null if it is not a money movement. */
export function toLedgerEntry(
  message: Record<string, unknown>,
  seq: number,
): LedgerEntry | null {
  if (message.type === "entry") {
    return {
      key: `${seq}`,
      kind: message.kind as "spend" | "revenue" | "reproduce" | "kill",
      agentId: String(message.agentId),
      label: String(message.label),
      headline: String(message.headline),
      amountUsd: Number(message.amountUsd),
      beforeUsd: Number(message.beforeUsd),
      afterUsd: Number(message.afterUsd),
      tick: Number(message.tick),
      txUrl: (message.txUrl as string | null) ?? null,
    };
  }
  if (message.type === "refused") {
    return {
      key: `${seq}`,
      kind: "refused",
      agentId: String(message.agentId),
      label: String(message.label),
      amountUsd: Number(message.amountUsd),
      reason: String(message.reason),
      tick: Number(message.tick),
    };
  }
  return null;
}
