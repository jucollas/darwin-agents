import type { Address } from "viem";
import { NextResponse } from "next/server";
import { UNAUTHORIZED, userFrom } from "@/lib/auth";
import { createAdPlatform } from "@/lib/ads";
import { explorerTx } from "@/lib/chain";
import { tick } from "@/lib/engine";
import { remainingAllowance } from "@/lib/evolution";
import {
  chainConfig,
  persist,
  requireSession,
  walletIndexFor,
} from "@/lib/store";
import type { Agent, Micro } from "@/lib/types";
import { toUsd } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Advance the market. One tick is one trading day for every living agent.
 *
 * When the chain is configured every one of those days settles for real: each agent signs
 * its own spend(), revenue is recorded through the oracle, and the generation boundary
 * moves inherited allowance with reproduce() and closes dead wallets with kill(). The day
 * is streamed as it happens, because a dozen testnet round trips is a while to watch a
 * spinner and the individual transactions are the thing worth seeing.
 */
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const count = Math.min(
    Math.max(Number(searchParams.get("ticks") ?? 1), 1),
    30,
  );
  // The caller can opt out of settling, which is what keeps the headless sim and the
  // "just move the simulation along" path fast.
  const onChain = searchParams.get("chain") !== "off";

  const userId = await userFrom(request);
  if (!userId) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  let session: ReturnType<typeof requireSession>;
  try {
    session = requireSession(userId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }

  const cfg = chainConfig();
  const bridge = session.bridge;
  const settling = onChain && cfg !== null && bridge !== null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          // Reader gone; the day still finishes and persists.
        }
      };

      /** One line in the ledger: who moved money, which way, and the proof. */
      const entry = (e: {
        agentId: string;
        label: string;
        kind: "spend" | "revenue" | "reproduce" | "kill";
        headline: string;
        amountUsd: number;
        beforeUsd: number;
        afterUsd: number;
        tick: number;
        hash: string | null;
      }) =>
        send({
          type: "entry",
          ...e,
          txUrl: e.hash && cfg ? explorerTx(cfg, e.hash) : null,
        });

      try {
        send({
          type: "start",
          ticks: count,
          settling,
          chain: settling && cfg ? cfg.chain.name : null,
          fromTick: session.campaign.tick,
        });

        // Registering lazily inside the spend hook would put a second transaction in the
        // middle of the first payment; doing it up front keeps the ledger readable.
        const ensureRegistered = async (agent: Agent) => {
          if (!settling || !bridge || agent.address) return;
          const campaignId = session.campaign.chain.campaignId;
          if (!campaignId) return;
          const index = walletIndexFor(session, agent.id);
          const registered = await bridge.registerAgent({
            campaignId: BigInt(campaignId),
            index,
            allowanceMicro: remainingAllowance(agent),
            epochCapMicro: agent.epochCapMicro,
            genome: agent.genome,
          });
          agent.address = registered.address;
          agent.txs.push({
            kind: "register",
            hash: registered.hash,
            amountMicro: remainingAllowance(agent),
            memo: "registered",
            tick: session.campaign.tick,
          });
          send({
            type: "registered",
            agentId: agent.id,
            label: agent.label,
            address: registered.address,
            txUrl: cfg ? explorerTx(cfg, registered.hash) : null,
          });
        };

        // The campaign has to hold money on chain before any agent can draw on it.
        if (settling && bridge && !session.campaign.chain.campaignId && cfg) {
          const opened = await bridge.openCampaign({
            fundingMicro: session.campaign.budgetMicro,
            globalCapMicro: session.campaign.globalCapMicro,
            epochSeconds: 60,
          });
          session.campaign.chain = {
            chainId: cfg.chain.id,
            treasury: cfg.treasury,
            token: cfg.token,
            campaignId: opened.campaignId.toString(),
            explorer: cfg.chain.blockExplorers?.default.url ?? null,
            live: true,
          };
          send({
            type: "funded",
            amountUsd: toUsd(session.campaign.budgetMicro),
            capUsd: toUsd(session.campaign.globalCapMicro),
            txUrl: explorerTx(cfg, opened.hashes[opened.hashes.length - 1]),
          });
        }

        const payTo = (process.env.AD_NETWORK_ADDRESS ??
          "0x000000000000000000000000000000000000dEaD") as Address;

        const hooks = settling && bridge
          ? {
              onSpend: async (
                agent: Agent,
                amountMicro: Micro,
                memo: string,
              ) => {
                await ensureRegistered(agent);
                if (!agent.address) return null;
                const index = walletIndexFor(session, agent.id);
                const before = remainingAllowance(agent);

                // A ceiling refusing the spend is the contract working, not the day
                // failing: record it and let the agent trade on without the inventory.
                try {
                  const hash = await bridge.spend(
                    index,
                    payTo,
                    amountMicro,
                    memo,
                  );
                  entry({
                    agentId: agent.id,
                    label: agent.label,
                    kind: "spend",
                    headline: `${agent.label} paid the exchange`,
                    amountUsd: toUsd(amountMicro),
                    beforeUsd: toUsd(before),
                    afterUsd: toUsd(before - amountMicro),
                    tick: session.campaign.tick + 1,
                    hash,
                  });
                  return hash;
                } catch (e) {
                  send({
                    type: "refused",
                    agentId: agent.id,
                    label: agent.label,
                    amountUsd: toUsd(amountMicro),
                    reason: revertReason(e),
                    tick: session.campaign.tick + 1,
                  });
                  return null;
                }
              },

              onRevenue: async (
                agent: Agent,
                amountMicro: Micro,
                conversionId: string,
              ) => {
                if (!agent.address) return null;
                const index = walletIndexFor(session, agent.id);
                const before = remainingAllowance(agent);
                try {
                  const hash = await bridge.recordRevenue(
                    index,
                    amountMicro,
                    conversionId,
                  );
                  entry({
                    agentId: agent.id,
                    label: agent.label,
                    kind: "revenue",
                    headline: `${agent.label} earned a sale`,
                    amountUsd: toUsd(amountMicro),
                    beforeUsd: toUsd(before),
                    afterUsd: toUsd(before + amountMicro),
                    tick: session.campaign.tick + 1,
                    hash,
                  });
                  return hash;
                } catch {
                  return null;
                }
              },

              onBirth: async (child: Agent, parent: Agent) => {
                if (!parent.address) return null;
                const parentIndex = walletIndexFor(session, parent.id);
                const childIndex = walletIndexFor(session, child.id);
                try {
                  const born = await bridge.reproduce({
                    parentIndex,
                    childIndex,
                    allowanceMicro: child.allowanceMicro,
                    epochCapMicro: child.epochCapMicro,
                    genome: child.genome,
                  });
                  child.address = born.address;
                  entry({
                    agentId: child.id,
                    label: child.label,
                    kind: "reproduce",
                    headline: `${parent.label} passed budget to ${child.label}`,
                    amountUsd: toUsd(child.allowanceMicro),
                    beforeUsd: 0,
                    afterUsd: toUsd(child.allowanceMicro),
                    tick: session.campaign.tick,
                    hash: born.hash,
                  });
                  return born.hash;
                } catch {
                  return null;
                }
              },

              onDeath: async (agent: Agent) => {
                if (!agent.address) return null;
                const index = walletIndexFor(session, agent.id);
                try {
                  const hash = await bridge.kill(index);
                  entry({
                    agentId: agent.id,
                    label: agent.label,
                    kind: "kill",
                    headline: `${agent.label} was shut down`,
                    amountUsd: toUsd(remainingAllowance(agent)),
                    beforeUsd: toUsd(remainingAllowance(agent)),
                    afterUsd: 0,
                    tick: session.campaign.tick,
                    hash,
                  });
                  return hash;
                } catch {
                  return null;
                }
              },
            }
          : {};

        for (let i = 0; i < count; i++) {
          send({ type: "day", tick: session.campaign.tick + 1 });
          const report = await tick(
            session.campaign,
            session.market,
            session.rng,
            {
              ...hooks,
              adPlatform: session.adPlatform,
              originUrl: new URL(request.url).origin,
            },
          );
          send({ type: "dayDone", report });
        }

        // Children born during these ticks need wallet slots reserved, whether or not the
        // chain is wired up, so a later proof uses the address the dashboard shows.
        for (const agent of session.campaign.agents)
          walletIndexFor(session, agent.id);

        persist(userId);
        send({
          type: "done",
          tick: session.campaign.tick,
          generation: session.campaign.generation,
        });
      } catch (e) {
        persist(userId);
        send({ type: "error", message: (e as Error).message.split("\n")[0] });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed or cancelled.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
    },
  });
}

/** Pull the custom error name out of a viem revert — the sentence worth reading. */
function revertReason(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  const match = message.match(
    /(AllowanceExceeded|EpochCapExceeded|GlobalCapExceeded|CampaignPaused|AgentDead|AgentExists|AgentUnknown|CampaignUnknown|NotOwner|InsufficientTreasury|ZeroAddress)/,
  );
  return match ? match[1] : message.split("\n")[0];
}
