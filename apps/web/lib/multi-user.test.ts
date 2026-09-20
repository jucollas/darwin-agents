import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Two people using the app at the same time.
 *
 * Every campaign used to be the same campaign: one global session, one snapshot. Now each
 * user owns theirs, and the guarantees that matter are that one person cannot see, spend or
 * delete another's — and that their agents never share a wallet, which on chain would mean
 * registerAgent reverting with AgentExists().
 */

let cwd: string;
let dir: string;

const ALICE = "did:privy:test-alice";
const BOB = "did:privy:test-bob";

beforeAll(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "darwin-multiuser-"));
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

function input(name: string, seed: number) {
  return {
    product: { name, priceUsd: 49, margin: 0.62, category: "wellness" },
    budgetUsd: 150,
    perAgentUsd: 25,
    epochCapUsd: 6,
    populationSize: 4,
    seed,
    evolution: { ticksPerGeneration: 3, maxPopulation: 8, minPopulation: 2 },
  };
}

describe("two users, two campaigns", () => {
  it("keeps each user's agents, budget and wallets to themselves", async () => {
    const { startCampaign, getSession, endCampaign, walletIndexFor } =
      await import("./store");

    const alice = await startCampaign(ALICE, input("Sleep Mask", 11));
    const bob = await startCampaign(BOB, input("Chemex", 22));

    // Different campaigns, not two views of one.
    expect(alice.campaign.id).not.toBe(bob.campaign.id);
    expect(getSession(ALICE)?.campaign.product.name).toBe("Sleep Mask");
    expect(getSession(BOB)?.campaign.product.name).toBe("Chemex");

    // No agent is shared.
    const aliceIds = new Set(alice.campaign.agents.map((a) => a.id));
    for (const agent of bob.campaign.agents)
      expect(aliceIds.has(agent.id)).toBe(false);

    // And no wallet is: a collision here is AgentExists() on chain.
    const aliceWallets = new Set(
      alice.campaign.agents.map((a) => walletIndexFor(alice, a.id)),
    );
    const bobWallets = bob.campaign.agents.map((a) => walletIndexFor(bob, a.id));
    expect(bobWallets.some((i) => aliceWallets.has(i))).toBe(false);

    // Bob starting over leaves Alice's population exactly where it was.
    endCampaign(BOB);
    expect(getSession(BOB)).toBeNull();
    expect(getSession(ALICE)?.campaign.agents.length).toBe(
      alice.campaign.agents.length,
    );
  }, 20_000);

  it("finds the right owner from an agent's tracking link", async () => {
    const { startCampaign, sessionByTracking } = await import("./store");

    const alice = await startCampaign(ALICE, input("Sleep Mask", 33));
    const bob = await startCampaign(BOB, input("Chemex", 44));

    // The storefront has no login, so the tracking id has to say whose sale this is.
    const fromAlice = alice.campaign.agents[0].trackingId;
    const fromBob = bob.campaign.agents[0].trackingId;

    expect(sessionByTracking(fromAlice)?.userId).toBe(ALICE);
    expect(sessionByTracking(fromBob)?.userId).toBe(BOB);
    expect(sessionByTracking("not-a-real-tracking-id")).toBeNull();
  }, 20_000);
});
