import { NextResponse } from "next/server";
import { log } from "@/lib/engine";
import { persist, sessionByTracking, walletIndexFor } from "@/lib/store";
import { type Micro, toUsd } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * A sale on the storefront, attributed to the agent whose tracking link brought the visitor.
 *
 * When the chain is wired up the revenue is settled through AgentTreasury.recordRevenue(),
 * which moves real tokens in from the oracle — so an agent's revenue is money that arrived,
 * not a number the backend decided to write down.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));

  // No login here on purpose: the buyer is a stranger who clicked an ad. The tracking id
  // is what identifies the agent, and through it the campaign the sale belongs to.
  const owner = sessionByTracking(String(body.tracking));
  if (!owner)
    return NextResponse.json(
      { error: "That tracking link is not ours." },
      { status: 404 },
    );

  const { userId, session } = owner;
  const { campaign } = session;
  const agent = campaign.agents.find(
    (a) => a.trackingId === String(body.tracking),
  );

  if (!agent)
    return NextResponse.json(
      { error: "That tracking link is not ours." },
      { status: 404 },
    );
  if (agent.status === "dead") {
    return NextResponse.json(
      {
        error: `${agent.label} was shut down, so this sale cannot be credited to it.`,
      },
      { status: 409 },
    );
  }

  const revenueMicro = Math.round(
    campaign.product.priceUsd * campaign.product.margin * 1_000_000,
  ) as Micro;
  const conversionId = `${agent.trackingId}-manual-${Date.now()}`;

  let hash: string | null = null;
  if (session.bridge && campaign.chain.live && agent.address) {
    try {
      hash = await session.bridge.recordRevenue(
        walletIndexFor(session, agent.id),
        revenueMicro,
        conversionId,
      );
    } catch (e) {
      // A chain hiccup must not lose the sale; the off-chain ledger still records it.
      log(
        campaign,
        "chain",
        agent.id,
        `Could not settle on chain: ${(e as Error).message}`,
      );
    }
  }

  agent.conversions += 1;
  agent.clicks += 1;
  agent.revenueMicro += revenueMicro;
  agent.txs.push({
    kind: "revenue",
    hash,
    amountMicro: revenueMicro,
    memo: conversionId,
    tick: campaign.tick,
  });

  log(
    campaign,
    "conversion",
    agent.id,
    `${agent.label} made a sale on the storefront for $${toUsd(revenueMicro).toFixed(2)}`,
    revenueMicro,
  );
  persist(userId);

  return NextResponse.json({
    ok: true,
    agent: agent.label,
    revenueUsd: toUsd(revenueMicro),
    txHash: hash,
    message: `$${toUsd(revenueMicro).toFixed(2)} credited to ${agent.label}${hash ? ", settled on chain" : ""}.`,
  });
}
