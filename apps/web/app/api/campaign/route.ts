import { NextResponse } from "next/server";
import { UNAUTHORIZED, userFrom } from "@/lib/auth";
import { activeScenario, resolveSeed } from "@/lib/ads/scenario";
import { generateCreatives, missingConfigHint } from "@/lib/creative";
import {
  chainConfig,
  endCampaign,
  getSession,
  persist,
  startCampaign,
} from "@/lib/store";
import { toView } from "@/lib/view";

export const dynamic = "force-dynamic";
// Launch now waits on one model call to write the founders' ads. Vercel's Hobby plan caps a
// function at 60s and would otherwise cut it off at its 10s default, leaving the campaign
// created but still holding template copy.
export const maxDuration = 60;

export async function GET(request: Request) {
  const userId = await userFrom(request);
  if (!userId) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const session = getSession(userId);
  if (!session)
    return NextResponse.json({
      campaign: null,
      chain: chainStatus(),
      scenario: scenarioStatus(),
    });

  return NextResponse.json({
    campaign: toView(session.campaign),
    chain: chainStatus(),
    scenario: scenarioStatus(),
  });
}

/** Tells the dashboard the run is reproducible, and which scenario it is. */
function scenarioStatus() {
  const s = activeScenario();
  return s ? { name: s.name, seed: s.seed, summary: s.summary } : null;
}

function chainStatus() {
  const cfg = chainConfig();
  if (!cfg) return { configured: false as const };
  return {
    configured: true as const,
    chainId: cfg.chain.id,
    name: cfg.chain.name,
    explorer: cfg.chain.blockExplorers?.default.url ?? null,
    treasury: cfg.treasury,
  };
}

export async function POST(request: Request) {
  const userId = await userFrom(request);
  if (!userId) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const body = await request.json().catch(() => ({}) as Record<string, unknown>);

  const budgetUsd = Number(body.budgetUsd);
  const populationSize = Number(body.populationSize ?? 6);
  // Only a slice of the budget is committed to generation 0. The rest is the reserve that
  // pays for children and for fresh strategies when selection thins the population out —
  // hand it all over at the start and evolution has nothing left to work with.
  //
  // The per-agent share is small on purpose. Telling a good strategy from an unlucky one
  // takes dozens of sales, so the budget has to cover many agent lifetimes, not six.
  const perAgentUsd = Number(body.perAgentUsd ?? budgetUsd * 0.035);
  const epochCapUsd = Number(body.epochCapUsd ?? perAgentUsd / 12);

  if (!body.product?.name) {
    return NextResponse.json(
      { error: "Name the product you want to sell." },
      { status: 400 },
    );
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    return NextResponse.json(
      { error: "Set a campaign budget above zero." },
      { status: 400 },
    );
  }
  if (perAgentUsd > budgetUsd) {
    return NextResponse.json(
      { error: "Per-agent budget cannot exceed the campaign budget." },
      { status: 400 },
    );
  }
  // Generation 0 must not consume the whole pot: children inherit from what is left, so a
  // population that allocates everything up front can never reproduce.
  if (perAgentUsd * populationSize > budgetUsd) {
    return NextResponse.json(
      {
        error: `${populationSize} agents at $${perAgentUsd.toFixed(0)} each needs $${(perAgentUsd * populationSize).toFixed(0)}, more than the $${budgetUsd.toFixed(0)} budget.`,
      },
      { status: 400 },
    );
  }
  if (!Number.isFinite(epochCapUsd) || epochCapUsd <= 0) {
    return NextResponse.json(
      { error: "Set a daily ceiling above zero." },
      { status: 400 },
    );
  }

  const session = await startCampaign(userId, {
    product: {
      name: String(body.product.name),
      priceUsd: Number(body.product.priceUsd ?? 49),
      margin: Number(body.product.margin ?? 0.6),
      category: String(body.product.category ?? "general"),
      // The wizard's free-text box lands here: it is what the agents read before pitching,
      // and the market already uses it as a hint about who wants this.
      // The audience field and the free-text brief both feed what the agents read. Kept
      // joined rather than overwriting each other: the user's own words stay canonical.
      audienceHint:
        [body.audience ? String(body.audience) : "", body.context ? String(body.context) : ""]
          .filter(Boolean)
          .join(" ") ||
        (body.product.audienceHint ? String(body.product.audienceHint) : "") ||
        undefined,
    },
    images: Array.isArray(body.images)
      ? body.images.slice(0, 8).map(String)
      : [],
    landingUrl: body.landingUrl ? String(body.landingUrl) : null,
    budgetUsd,
    perAgentUsd,
    epochCapUsd,
    populationSize,
    // An explicit seed wins; otherwise DEMO_SCENARIO / SIMULATION_SEED make the run
    // reproducible, so a rehearsed demo behaves on stage the way it did in rehearsal.
    seed: resolveSeed(body.seed !== undefined ? Number(body.seed) : undefined),
    evolution: {
      ticksPerGeneration: Number(body.ticksPerGeneration ?? 3),
      maxPopulation: Number(
        body.maxPopulation ?? Math.max(8, populationSize + 4),
      ),
      minPopulation: Number(
        body.minPopulation ?? Math.max(3, Math.floor(populationSize / 2)),
      ),
    },
  });

  // Let the founders write their own ads before the dashboard opens.
  //
  // createCampaign() already gave each one a template ad so the population is never empty,
  // but template copy is the weakest thing a juror can be shown first: five fixed sentences
  // with the product name slotted in. One call replaces all of them with copy the model
  // actually wrote for that genome. It costs the launch a few seconds and is the difference
  // between "these agents write ads" being a claim and being visible.
  //
  // Failure is survivable by construction: the templates are already in place, so a missing
  // key, a timeout or a bad response leaves the demo exactly as it was.
  const alive = session.campaign.agents.filter((a) => a.status === "alive");
  let copySource: "llm" | "template" = "template";
  let copyNote: string | null = null;

  try {
    const creatives = await generateCreatives({
      product: session.campaign.product,
      context: session.campaign.product.audienceHint ?? "",
      image: null,
      imageRef: session.campaign.images[0] ?? null,
      tick: 0,
      agents: alive.map((a) => ({
        id: a.id,
        label: a.label,
        genome: a.genome,
      })),
    });

    for (const agent of alive) {
      const written = creatives.get(agent.id);
      if (!written) continue;
      agent.creative = written;
      agent.creatives = [written];
      if (written.source === "llm") copySource = "llm";
    }
    if (copySource === "template") copyNote = missingConfigHint();
    persist(userId);
  } catch (e) {
    // The templates written at creation stay exactly where they are.
    copyNote = (e as Error).message.split("\n")[0];
  }

  return NextResponse.json({
    campaignId: session.campaign.id,
    agents: session.campaign.agents.length,
    // So the UI can say plainly who wrote the ads it is about to show.
    copySource,
    copyNote,
  });
}

export async function DELETE(request: Request) {
  const userId = await userFrom(request);
  if (!userId) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  endCampaign(userId);
  return NextResponse.json({ ok: true });
}
