import { NextResponse } from "next/server";
import { UNAUTHORIZED, userFrom } from "@/lib/auth";
import type { Address } from "viem";
import { chainConfig, requireSession } from "@/lib/store";
import {
  decodePayment,
  networkName,
  paymentRequired,
  verifyPayment,
} from "@/lib/x402";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The ad exchange. A real HTTP 402 resource: it quotes a price, refuses to serve inventory
 * without payment, and checks the payment against the chain rather than against a claim.
 *
 *   POST /api/services/ads            -> 402 with payment requirements
 *   POST /api/services/ads + X-PAYMENT -> 200 with the inventory
 *
 * The payer is an autonomous agent spending from its own wallet, and its budget ceiling is
 * enforced by AgentTreasury, not by this endpoint trusting it to behave.
 */
export async function POST(request: Request) {
  const cfg = chainConfig();
  if (!cfg) {
    return NextResponse.json(
      {
        error:
          "The exchange is not settled on chain in this deployment. Set TREASURY_ADDRESS and TOKEN_ADDRESS.",
      },
      { status: 503 },
    );
  }

  const userId = await userFrom(request);
  if (!userId) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  let session: ReturnType<typeof requireSession>;
  try {
    session = requireSession(userId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const agent = session.campaign.agents.find((a) => a.id === body.agentId);
  if (!agent)
    return NextResponse.json({ error: "Unknown agent." }, { status: 404 });
  if (!agent.address)
    return NextResponse.json(
      { error: "That agent has no wallet yet." },
      { status: 409 },
    );

  const priceMicro = Math.max(
    1,
    Math.round(Number(body.priceMicro ?? agent.epochCapMicro)),
  );
  const payTo = (process.env.AD_NETWORK_ADDRESS ?? EXCHANGE_TREASURY) as Address;
  const resource = new URL(request.url).toString();

  const header = request.headers.get("x-payment");
  if (!header) {
    return NextResponse.json(
      paymentRequired({
        network: networkName(cfg.chain.id),
        priceMicro,
        resource,
        description: `Ad inventory on ${agent.genome.platform} for a ${agent.genome.audience} audience`,
        payTo,
        asset: cfg.token,
        treasury: cfg.treasury,
      }),
      { status: 402 },
    );
  }

  const payment = decodePayment(header);
  if (!payment)
    return NextResponse.json(
      { error: "Malformed X-PAYMENT header." },
      { status: 400 },
    );

  const bridge = session.bridge;
  if (!bridge)
    return NextResponse.json(
      { error: "No chain bridge available." },
      { status: 503 },
    );

  const verdict = await verifyPayment({
    bridge,
    payment,
    expectedPayer: agent.address,
    expectedPayee: payTo,
    minimumMicro: priceMicro,
  });

  if (!verdict.ok) {
    return NextResponse.json(
      { error: `Payment rejected: ${verdict.reason}` },
      { status: 402 },
    );
  }

  const result = session.market.serveAds(
    agent.genome,
    verdict.amountMicro,
    session.rng,
  );

  return NextResponse.json(
    {
      settled: {
        txHash: verdict.txHash,
        amountMicro: verdict.amountMicro,
        payer: verdict.payer,
      },
      inventory: {
        platform: agent.genome.platform,
        audience: agent.genome.audience,
        impressions: result.impressions,
        cpmMicro: result.cpmMicro,
        trackingUrl: `/buy/${agent.trackingId}`,
      },
    },
    {
      status: 200,
      headers: {
        "X-PAYMENT-RESPONSE": Buffer.from(
          JSON.stringify({
            success: true,
            txHash: verdict.txHash,
            network: networkName(cfg.chain.id),
          }),
        ).toString("base64"),
      },
    },
  );
}

/**
 * Where ad spend lands. A burn-style sink stands in for the exchange's own treasury: the
 * money has demonstrably left the campaign, which is the property the accounting needs.
 */
const EXCHANGE_TREASURY = "0x000000000000000000000000000000000000dEaD" as const;
