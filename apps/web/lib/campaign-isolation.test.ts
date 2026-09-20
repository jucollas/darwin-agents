import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The speaker presses "+ New campaign" in front of an audience. If anything from the
 * previous run leaks through — an agent, a publication, a metric, an event — the demo
 * silently lies. This is the test that says it does not.
 */

let cwd: string;
let dir: string;

beforeAll(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "darwin-isolation-"));
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

function input(name: string, seed: number) {
  return {
    product: { name, priceUsd: 49, margin: 0.62, category: "food" },
    budgetUsd: 60_000,
    perAgentUsd: 2_100,
    epochCapUsd: 175,
    populationSize: 6,
    seed,
    evolution: { ticksPerGeneration: 3, maxPopulation: 10, minPopulation: 3 },
  };
}

describe("a new campaign starts clean", () => {
  it("shares no agents, publications, metrics or events with the previous one", async () => {
    const { startCampaign, endCampaign, getSession } = await import("./store");
    const { tick } = await import("./engine");

    // First campaign: run it far enough to accumulate history worth leaking.
    const first = await startCampaign(input("Electric Bicycle", 999));
    for (let i = 0; i < 6; i++)
      await tick(first.campaign, first.market, first.rng, {
        adPlatform: first.adPlatform,
        originUrl: "http://demo.test",
      });

    const firstIds = new Set(first.campaign.agents.map((a) => a.id));
    expect(first.campaign.events.length).toBeGreaterThan(0);
    expect(first.campaign.tick).toBe(6);

    // What the "+ New campaign" button does.
    endCampaign();
    expect(getSession()).toBeNull();

    const second = await startCampaign(input("Espresso Machine", 7));

    // Nothing carried over.
    expect(second.campaign.id).not.toBe(first.campaign.id);
    expect(second.campaign.tick).toBe(0);
    expect(second.campaign.product.name).toBe("Espresso Machine");
    for (const agent of second.campaign.agents) {
      expect(firstIds.has(agent.id)).toBe(false);
      expect(agent.spentMicro).toBe(0);
      expect(agent.revenueMicro).toBe(0);
      expect(agent.conversions).toBe(0);
      expect(agent.status).toBe("alive");
      // Founders launch with their own ad, written for the new product.
      expect(agent.creatives.length).toBe(1);
      expect(agent.creative?.headline).toContain("Espresso Machine");
      // And no campaign from the previous run.
      expect(agent.adCampaignId).toBeNull();
    }

    // The first campaign's own object is untouched — isolation, not mutation.
    expect(first.campaign.tick).toBe(6);
    expect(first.campaign.product.name).toBe("Electric Bicycle");
    // Two campaigns' worth of BIP-32 derivation, which is deliberately slow work. It fits
    // in the default 5s alone and does not when the suite runs it beside the other file
    // deriving wallets, so the budget is stated rather than left to scheduling luck.
  }, 20_000);

  it("gives the second campaign its own ad platform, so campaign ids cannot collide", async () => {
    const { startCampaign, endCampaign } = await import("./store");

    const a = await startCampaign(input("Bike", 999));
    const created = await a.adPlatform.createCampaign({
      agentId: a.campaign.agents[0].id,
      genome: a.campaign.agents[0].genome,
      destinationUrl: "http://demo.test/buy/x",
      budgetMicro: 1_000_000,
      dailyBudgetMicro: 100_000,
      tick: 0,
    });

    endCampaign();
    const b = await startCampaign(input("Machine", 999));
    // The new platform has never heard of the old campaign.
    expect(await b.adPlatform.getCampaign(created.campaignId)).toBeNull();
  });
});
