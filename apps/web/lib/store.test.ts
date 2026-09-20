import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * AgentTreasury keys agents by address globally, not per campaign. A second campaign that
 * restarted HD derivation from index 0 would re-derive the first campaign's wallets and the
 * chain would reject registerAgent with AgentExists() — which is exactly what happened when
 * the demo was run twice against one deployment.
 */

const PRODUCT = {
  name: "Aurora Sleep Mask",
  priceUsd: 49,
  margin: 0.62,
  category: "wellness",
};

let cwd: string;
let dir: string;

beforeAll(() => {
  // store.ts resolves its snapshot and cursor against process.cwd().
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "darwin-store-"));
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

async function walletIndicesFor(seed: number): Promise<number[]> {
  const { startCampaign } = await import("./store");
  const session = await startCampaign({
    product: PRODUCT,
    budgetUsd: 60_000,
    perAgentUsd: 2_100,
    epochCapUsd: 175,
    populationSize: 6,
    seed,
    evolution: { ticksPerGeneration: 3, maxPopulation: 10, minPopulation: 3 },
  });
  return [...session.walletIndex.values()];
}

describe("wallet derivation across campaigns", () => {
  it("never hands a new campaign the previous campaign's derivation indices", async () => {
    const first = await walletIndicesFor(11);
    const second = await walletIndicesFor(22);
    const third = await walletIndicesFor(33);

    expect(first.length).toBeGreaterThan(0);
    for (const later of [second, third]) {
      expect(later.length).toBe(first.length);
      expect(later.some((i) => first.includes(i))).toBe(false);
    }
    // Distinct blocks, so no two campaigns can collide on chain.
    const all = [...first, ...second, ...third];
    expect(new Set(all).size).toBe(all.length);
    // Three campaigns of BIP-32 derivation; same reason as the isolation test's budget.
  }, 20_000);

  it("keeps indices unique within a single campaign", async () => {
    const indices = await walletIndicesFor(44);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it("still separates campaigns when the cursor cannot be written", async () => {
    // Vercel's filesystem is read-only, so the cursor write throws and the fallback runs.
    // A fallback derived only from the clock would hand two campaigns created in the same
    // second the same block — the AgentExists() bug again, in the place we demo from.
    chmodSync(dir, 0o555);
    try {
      const first = await walletIndicesFor(55);
      const second = await walletIndicesFor(66);
      expect(second.some((i) => first.includes(i))).toBe(false);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
