import {
  type Agent,
  type Campaign,
  type CampaignEvent,
  type EvolutionConfig,
  type Micro,
  MICRO,
  toUsd,
} from "./types";
import { DEFAULT_EVOLUTION } from "./types";
import {
  type AdResult,
  type Market,
  type ProductSpec,
  BID,
  createMarket,
} from "./market";
import type { AdPlatform } from "./ads/types";
import { type Rng, mulberry32 } from "./rng";
import { describe } from "./genome";
import { templateCreative } from "./creative";
import {
  decideBudgetScale,
  livingAgents,
  populationStats,
  remainingAllowance,
  roiOf,
  runGeneration,
  seedPopulation,
} from "./evolution";

/**
 * The loop. One tick is one trading day for the population: every living agent buys as much
 * advertising as its budget allows, the market answers with clicks and sales, and every so
 * many ticks the generation boundary decides who lives.
 */

export type CampaignInput = {
  product: ProductSpec;
  images?: string[];
  landingUrl?: string | null;
  budgetUsd: number;
  perAgentUsd: number;
  epochCapUsd: number;
  populationSize: number;
  seed?: number;
  evolution?: Partial<EvolutionConfig>;
};

export function createCampaign(input: CampaignInput): {
  campaign: Campaign;
  market: Market;
} {
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = mulberry32(seed);

  const campaign: Campaign = {
    // Seed plus a launch marker. A pinned DEMO_SCENARIO means every campaign draws the same
    // seed, so the seed alone would give two consecutive demo runs the same id — and since
    // agent ids are scoped to the campaign, the second run's agents would collide with the
    // first's. The suffix keeps runs distinct without touching what the seed decides.
    id: `camp_${seed.toString(36)}_${Date.now().toString(36).slice(-4)}`,
    createdAt: new Date().toISOString(),
    product: input.product,
    images: input.images ?? [],
    landingUrl: input.landingUrl ?? null,

    budgetMicro: Math.round(input.budgetUsd * MICRO),
    globalCapMicro: Math.round(input.budgetUsd * MICRO),
    perAgentMicro: Math.round(input.perAgentUsd * MICRO),
    epochCapMicro: Math.round(input.epochCapUsd * MICRO),

    seed,
    tick: 0,
    generation: 0,
    paused: false,

    evolution: { ...DEFAULT_EVOLUTION, ...input.evolution },

    chain: {
      chainId: null,
      treasury: null,
      token: null,
      campaignId: null,
      explorer: null,
      live: false,
    },

    agents: [],
    events: [],
  };

  campaign.agents = seedPopulation(campaign, input.populationSize, rng);

  // Every founder arrives with an ad, so the gallery has something to show the moment the
  // population launches. Written from the template: no API call, no latency, and the copy
  // and artwork already differ per genome. A richer version is written if the operator
  // runs the pitch-off.
  for (const agent of campaign.agents) {
    const first = templateCreative(
      agent.genome,
      campaign.product,
      campaign.product.audienceHint ?? "",
      campaign.images[0] ?? null,
      0,
      null,
    );
    agent.creative = first;
    agent.creatives = [first];
  }
  for (const a of campaign.agents) {
    log(
      campaign,
      "birth",
      a.id,
      `${a.label} born into generation 0 — ${describe(a.genome)}`,
    );
  }

  return { campaign, market: createMarket(input.product, seed) };
}

/** What an agent intends to spend this tick, before any ceiling is applied. */
export function plannedSpend(agent: Agent, campaign: Campaign): Micro {
  const intensity = BID[agent.genome.bid].spendShare;
  // budgetScale is the agent's own decision, layered on top of what its genome implies.
  const wanted = Math.round(
    agent.epochCapMicro * intensity * (agent.budgetScale || 1),
  );

  const globalRemaining = Math.max(
    0,
    campaign.globalCapMicro - totalSpent(campaign),
  );
  return Math.max(
    0,
    Math.min(
      wanted,
      remainingAllowance(agent),
      agent.epochCapMicro,
      globalRemaining,
    ),
  );
}

export function totalSpent(campaign: Campaign): Micro {
  return campaign.agents.reduce((s, a) => s + a.spentMicro, 0);
}

export type TickReport = {
  tick: number;
  generationRan: boolean;
  activity: Array<{
    agentId: string;
    spendMicro: Micro;
    impressions: number;
    clicks: number;
    conversions: number;
    revenueMicro: Micro;
  }>;
  births: string[];
  deaths: Array<{ agentId: string; reason: string }>;
};

/**
 * Advance the simulation one tick.
 *
 * `onSpend` and `onRevenue` are where the chain plugs in: the web app passes handlers that
 * call AgentTreasury.spend() from the agent's own wallet and recordRevenue() from the
 * oracle. Headless runs leave them out and the economics stay identical.
 */
export async function tick(
  campaign: Campaign,
  market: Market,
  rng: Rng,
  hooks: {
    onSpend?: (
      agent: Agent,
      amountMicro: Micro,
      memo: string,
    ) => Promise<string | null>;
    onRevenue?: (
      agent: Agent,
      amountMicro: Micro,
      conversionId: string,
    ) => Promise<string | null>;
    /**
     * The generation boundary, on chain: `reproduce()` gives the child its own wallet and
     * the slice of allowance its parent gave up, and `kill()` closes a shut-down agent's.
     * Together with onSpend/onRevenue this makes the whole lineage reconstructible from
     * events alone, which is the claim the contract exists to support.
     */
    onBirth?: (child: Agent, parent: Agent) => Promise<string | null>;
    onDeath?: (agent: Agent) => Promise<string | null>;
    /**
     * The advertising network. When present, agents run real campaigns through it instead
     * of buying traffic straight from the market — same economics, but the lifecycle
     * (create, deliver, attribute, pause) goes through the interface an adapter implements.
     */
    adPlatform?: AdPlatform;
    /** Landing page a click lands on. The tracking id travels in the path, as on a network. */
    originUrl?: string;
  } = {},
): Promise<TickReport> {
  const report: TickReport = {
    tick: campaign.tick + 1,
    generationRan: false,
    activity: [],
    births: [],
    deaths: [],
  };

  if (campaign.paused) {
    log(
      campaign,
      "human",
      null,
      "Tick skipped — campaign paused by the operator",
    );
    return report;
  }

  for (const agent of livingAgents(campaign)) {
    const spendMicro = plannedSpend(agent, campaign);
    if (spendMicro <= 0) continue;

    const memo = `t${report.tick}:${agent.genome.platform}`;
    const spendTx = hooks.onSpend
      ? await hooks.onSpend(agent, spendMicro, memo)
      : null;

    // Charged after delivery, because what a campaign actually spends can be under what was
    // offered — impressions are whole, and the network stops at the campaign's budget.
    // Billing the offer instead would quietly overcharge an agent that asked for more than
    // the network could sell it.
    agent.spentMicro += spendMicro;
    agent.txs.push({
      kind: "spend",
      hash: spendTx,
      amountMicro: spendMicro,
      memo,
      tick: report.tick,
    });

    const result = hooks.adPlatform
      ? await serveViaPlatform(
          hooks.adPlatform,
          agent,
          campaign,
          spendMicro,
          report.tick,
          market,
          rng,
          hooks.originUrl ?? "",
        )
      : market.serveAds(agent.genome, spendMicro, rng);

    // Reconcile the charge to what the network actually billed.
    if (hooks.adPlatform && result.spendMicro !== spendMicro) {
      const delta = result.spendMicro - spendMicro;
      agent.spentMicro += delta;
      const last = agent.txs[agent.txs.length - 1];
      if (last?.kind === "spend") last.amountMicro = result.spendMicro;
    }

    agent.impressions += result.impressions;
    agent.clicks += result.clicks;
    agent.conversions += result.conversions;

    if (result.revenueMicro > 0) {
      const conversionId = `${agent.trackingId}-t${report.tick}`;
      const revTx = hooks.onRevenue
        ? await hooks.onRevenue(agent, result.revenueMicro, conversionId)
        : null;

      agent.revenueMicro += result.revenueMicro;
      agent.txs.push({
        kind: "revenue",
        hash: revTx,
        amountMicro: result.revenueMicro,
        memo: conversionId,
        tick: report.tick,
      });
      log(
        campaign,
        "conversion",
        agent.id,
        `${agent.label} converted ${result.conversions}x for $${toUsd(result.revenueMicro).toFixed(2)}`,
        result.revenueMicro,
      );
    }

    report.activity.push({
      agentId: agent.id,
      spendMicro,
      impressions: result.impressions,
      clicks: result.clicks,
      conversions: result.conversions,
      revenueMicro: result.revenueMicro,
    });
  }

  // Each agent reads its own numbers and decides what to do with its budget next tick.
  // This is the autonomous step: selection still decides who lives, but between generations
  // the agent is the one leaning in or pulling back.
  for (const agent of livingAgents(campaign)) {
    const before = agent.budgetScale;
    agent.budgetScale = decideBudgetScale(
      agent,
      campaign.evolution.minClicksToJudge,
    );
    if (agent.budgetScale !== before) {
      log(
        campaign,
        "human",
        agent.id,
        `${agent.label} ${agent.budgetScale > before ? "raised" : "cut"} its ad budget to ${Math.round(agent.budgetScale * 100)}% (ROI ${(roiOf(agent) * 100).toFixed(0)}%)`,
      );
    }
    // An agent that has decided to spend almost nothing pauses its campaign rather than
    // dribbling money away — the same call an operator would make in the network's UI.
    if (hooks.adPlatform && agent.adCampaignId) {
      // Pause only an agent that has been judged and is clearly losing — not one that is
      // simply spending a little less while it gathers evidence.
      const shouldPause =
        agent.clicks >= campaign.evolution.minClicksToJudge &&
        roiOf(agent) < -0.5;
      const isPaused = agent.adCampaignStatus === "paused";
      if (shouldPause && !isPaused) {
        const c = await hooks.adPlatform.pauseCampaign(agent.adCampaignId);
        agent.adCampaignStatus = c.status;
        log(campaign, "human", agent.id, `${agent.label} paused its ad campaign`);
      } else if (!shouldPause && isPaused) {
        const c = await hooks.adPlatform.resumeCampaign(agent.adCampaignId);
        agent.adCampaignStatus = c.status;
        log(campaign, "human", agent.id, `${agent.label} resumed its ad campaign`);
      }
    }
  }

  campaign.tick = report.tick;

  if (campaign.tick % campaign.evolution.ticksPerGeneration === 0) {
    const outcome = runGeneration(campaign, rng);
    report.generationRan = true;

    for (const { agent, reason, fitness } of outcome.killed) {
      report.deaths.push({ agentId: agent.id, reason });
      // Closing the agent on chain is what stops its wallet spending again, so it is
      // recorded as a transaction rather than only as a line in the log.
      const killTx = hooks.onDeath ? await hooks.onDeath(agent) : null;
      if (killTx)
        agent.txs.push({
          kind: "kill",
          hash: killTx,
          amountMicro: 0,
          memo: reason,
          tick: report.tick,
        });
      log(
        campaign,
        "death",
        agent.id,
        `${agent.label} shut down (${reason}) — fitness $${toUsd(fitness).toFixed(2)}`,
        fitness,
      );
    }

    campaign.agents.push(...outcome.born);
    for (const child of outcome.born) {
      report.births.push(child.id);
      const parent = campaign.agents.find((a) => a.id === child.parentId);
      // The inheritance is the money moving: the parent already gave up this allowance in
      // breed(), and reproduce() is where the chain learns the child may now spend it.
      if (parent && hooks.onBirth) {
        const birthTx = await hooks.onBirth(child, parent);
        if (birthTx)
          child.txs.push({
            kind: "reproduce",
            hash: birthTx,
            amountMicro: child.allowanceMicro,
            memo: `from ${parent.label}`,
            tick: report.tick,
          });
      }
      log(
        campaign,
        "birth",
        child.id,
        `${child.label} born from ${parent?.label ?? child.parentId} — mutated ${child.mutatedGenes.join(", ") || "nothing"}`,
      );

      // A child that inherited a mutated genome must not inherit the parent's ad: the whole
      // point of the generation boundary is that a new strategy produces a new publication.
      // Written from the template here — synchronously, off the deterministic path, and
      // with no API call, so a generation boundary never stalls the simulation. A richer
      // version is written later if the operator runs the pitch-off.
      const born = templateCreative(
        child.genome,
        campaign.product,
        campaign.product.audienceHint ?? "",
        campaign.images[0] ?? null,
        report.tick,
        null,
      );
      child.creative = born;
      child.creatives = [born];
      log(
        campaign,
        "birth",
        child.id,
        `${child.label} published its first ad — ${describe(child.genome)}`,
      );
    }

    const stats = populationStats(campaign);
    log(
      campaign,
      "generation",
      null,
      `Generation ${outcome.generation}: ${stats.alive} alive, ${stats.dead} dead, population profit $${toUsd(stats.profitMicro).toFixed(2)}`,
      stats.profitMicro,
    );
  }

  return report;
}

/**
 * Run one tick of an agent's advertising through the network.
 *
 * The lifecycle is the one a real advertiser follows: open a campaign the first time, adjust
 * its daily budget to whatever the agent decided, buy a tick of traffic, then resolve each
 * click individually. A click converts or not according to the market's hidden truth for
 * that strategy — the network is never told to produce a sale, it is told a sale happened,
 * which is the same direction a real S2S postback travels.
 */
async function serveViaPlatform(
  platform: AdPlatform,
  agent: Agent,
  campaign: Campaign,
  spendMicro: Micro,
  tick: number,
  market: Market,
  rng: Rng,
  originUrl: string,
): Promise<AdResult> {
  const empty: AdResult = {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    revenueMicro: 0,
    ctr: 0,
    cvr: 0,
    cpmMicro: 0,
    spendMicro: 0,
    contributionMicro: market.contributionMicro,
  };

  if (!agent.adCampaignId) {
    const created = await platform.createCampaign({
      agentId: agent.id,
      genome: agent.genome,
      // The tracking id rides in the path, so a click arrives already attributed.
      destinationUrl: `${originUrl}/buy/${agent.trackingId}`,
      budgetMicro: remainingAllowance(agent),
      dailyBudgetMicro: spendMicro,
      tick,
    });
    agent.adCampaignId = created.campaignId;
    agent.adCampaignStatus = created.status;
    log(
      campaign,
      "chain",
      agent.id,
      `${agent.label} opened ad campaign ${created.campaignId}`,
    );
  } else {
    // The agent's budget decision reaches the network as a budget change, not a restart.
    await platform.updateBudget(agent.adCampaignId, spendMicro);
  }

  const delivery = await platform.deliver(agent.adCampaignId, tick);

  // Resolve each click on its own, the way a landing page would.
  const cvr = market.conversionRateFor(agent.genome, rng);
  let conversions = 0;
  let revenueMicro = 0;
  for (const click of delivery.clicks) {
    if (rng() >= cvr) continue;
    await platform.recordConversion(click.clickId, click.contributionMicro);
    conversions += 1;
    revenueMicro += click.contributionMicro;
  }

  const live = await platform.getCampaign(agent.adCampaignId);
  agent.adCampaignStatus = live?.status ?? agent.adCampaignStatus;

  return {
    ...empty,
    impressions: delivery.impressions,
    clicks: delivery.clicks.length,
    conversions,
    revenueMicro,
    spendMicro: delivery.spendMicro,
    ctr:
      delivery.impressions === 0
        ? 0
        : delivery.clicks.length / delivery.impressions,
    cvr,
  };
}

export function log(
  campaign: Campaign,
  kind: CampaignEvent["kind"],
  agentId: string | null,
  message: string,
  amountMicro?: Micro,
): void {
  campaign.events.push({
    tick: campaign.tick,
    at: new Date().toISOString(),
    kind,
    agentId,
    message,
    amountMicro,
  });
  if (campaign.events.length > 2000)
    campaign.events.splice(0, campaign.events.length - 2000);
}

/** Parent -> children, for drawing the lineage tree. */
export function lineage(campaign: Campaign): Map<string | null, Agent[]> {
  const byParent = new Map<string | null, Agent[]>();
  for (const a of campaign.agents) {
    const list = byParent.get(a.parentId) ?? [];
    list.push(a);
    byParent.set(a.parentId, list);
  }
  return byParent;
}
