import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SOLO_USER } from "./auth";

/**
 * AgentTreasury keys agents by address globally, not per campaign. A second campaign that
 * restarted HD derivation from index 0 would re-derive the first campaign's wallets and the
 * chain would reject registerAgent with AgentExists() — which is exactly what happened when
 * the demo was run twice against one deployment.
 */

/** Mirrors store.ts: how many blocks fit under BIP-32's non-hardened limit. */
const BLOCK_CEILING = Math.floor(2 ** 31 / 256);

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
  const session = await startCampaign(SOLO_USER, {
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

  it("stays inside the range BIP-32 can actually derive", async () => {
    // Blocks are drawn at random with no cursor, and `agentAccount()` derives at
    // `index + 1`. viem rejects a non-hardened addressIndex at or above 2^31, so a draw
    // that overflows does not collide — it fails outright and no agent gets a wallet.
    chmodSync(dir, 0o555);
    try {
      const { mnemonicToAccount } = await import("viem/accounts");
      const mnemonic =
        "test test test test test test test test test test test junk";
      for (const seed of [77, 88, 99]) {
        const indices = await walletIndicesFor(seed);
        const highest = Math.max(...indices);
        expect(highest + 1).toBeLessThan(2 ** 31);
        // Not just arithmetic: the top index of the block has to derive for real.
        expect(() =>
          mnemonicToAccount(mnemonic, { addressIndex: highest + 1 }),
        ).not.toThrow();
      }
    } finally {
      chmodSync(dir, 0o755);
    }
  }, 20_000);

  it("does not depend on the clock to separate two cold instances", () => {
    // The bug this replaced: the fallback offset was `Date.now()/1000 % 4096`, so two
    // instances booting in the same second — or 68 minutes apart, when the window wrapped —
    // drew the same block. On Vercel /tmp is wiped between instances, so that fallback is
    // the normal path, and the second campaign reverted with AgentExists().
    //
    // A cold instance means `blocksClaimedThisProcess` back at zero, which is not something
    // this process can re-enter — the counter is module state, and the in-process stepping
    // is exactly what masked the clock in the first place. So the two strategies are
    // modelled here directly, each call standing for one fresh instance.
    const cold = (draw: () => number) => {
      let counter = 0;
      return () => (draw() + counter++) % BLOCK_CEILING;
    };
    const frozenSecond = 1_700_000_000_000;
    const byClock = () => Math.floor(frozenSecond / 1000) % 4096;
    const byRandom = () => randomInt(0, BLOCK_CEILING);

    // Three instances booting in the same second, under the old scheme: one block, shared.
    const clocked = [cold(byClock)(), cold(byClock)(), cold(byClock)()];
    expect(new Set(clocked).size).toBe(1);

    // The same three under the current one, drawn independently.
    const drawn = Array.from({ length: 3 }, () => cold(byRandom)());
    expect(new Set(drawn).size).toBe(3);
  });
});
