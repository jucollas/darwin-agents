import { createHash, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SOLO_USER } from "./auth";
import { type AdPlatform, createAdPlatform } from "./ads";
import { ChainBridge, type ChainConfig, configFromEnv } from "./chain";
import { type CampaignInput, createCampaign } from "./engine";
import { resetAgentCounter } from "./evolution";
import { type Market, createMarket } from "./market";
import { type Rng, mulberry32 } from "./rng";
import type { Campaign } from "./types";

/**
 * One campaign at a time, held in the server process.
 *
 * The economics of record live on chain — this is a cache of the strategies, creatives and
 * market history that would be pointless to store in a contract. A JSON snapshot on disk
 * means a dev-server restart mid-demo does not lose the population.
 */

type Session = {
  campaign: Campaign;
  market: Market;
  rng: Rng;
  bridge: ChainBridge | null;
  /** The advertising network this run talks to. Seeded, so a demo replays identically. */
  adPlatform: AdPlatform;
  /** Agent id -> HD derivation index, so a restart recovers the same wallets. */
  walletIndex: Map<string, number>;
  nextWalletIndex: number;
};

/**
 * Derivation indices are handed out in one block per campaign.
 *
 * AgentTreasury keys agents by address globally, not per campaign, so a second campaign that
 * restarted numbering from 0 would re-derive the first campaign's wallets and revert with
 * AgentExists(). Each campaign therefore starts at a fresh multiple of this stride, which
 * also caps how many agents one campaign can register on chain.
 */
const WALLET_BLOCK = 256;

/**
 * How many blocks fit under BIP-32's non-hardened index limit.
 *
 * `agentAccount()` derives at `block * WALLET_BLOCK + n`, and viem refuses an
 * `addressIndex` at or above 2^31, so a block drawn at random has to stay below this or the
 * agents in it cannot be derived at all.
 */
const BLOCK_CEILING = Math.floor(2 ** 31 / WALLET_BLOCK);

/**
 * Where the snapshot and cursor live.
 *
 * On Vercel `process.cwd()` is the read-only bundle, so a write there throws and the session
 * only ever exists in the memory of whichever instance created it — a tick that lands on a
 * different instance finds nothing and answers "No campaign yet". `/tmp` is the one writable
 * path, and it is shared by every invocation on the same instance, so the snapshot survives.
 */
const DATA_DIR = process.env.VERCEL ? "/tmp/darwin" : resolve(process.cwd(), "data");

const WALLET_CURSOR = resolve(DATA_DIR, "wallet-cursor.json");

/**
 * The next free derivation block, persisted next to the snapshot.
 *
 * It has to outlive an individual campaign: ending one and starting another must not hand
 * the new population the old addresses.
 *
 * When the cursor cannot be written — a serverless filesystem is read-only — the block is
 * derived from a process-lifetime counter on top of a start-time offset. The counter is what
 * guarantees two campaigns never collide; a bare timestamp does not, because two campaigns
 * created within the same tick of the clock would round to the same block.
 */
let blocksClaimedThisProcess = 0;

function claimWalletBlock(): number {
  let next: number | null = null;
  try {
    next = JSON.parse(readFileSync(WALLET_CURSOR, "utf8"))?.nextBlock ?? null;
  } catch {
    // No cursor here.
  }
  if (!Number.isInteger(next) || (next as number) < 0) next = null;

  // No cursor means a fresh disk, not a fresh chain.
  //
  // On Vercel /tmp is writable but starts empty on every new instance, so this is the
  // common case and the one that used to bite: starting at block 0 handed each instance
  // the same low indices, whose agents are already registered from earlier runs, and
  // registerAgent reverted with AgentExists(). The cursor then counted up from 0 inside
  // that instance while the next instance started from 0 all over again.
  //
  // Seeding at random instead makes a cold instance pick an unused block, and the cursor
  // keeps stepping forward from there for as long as that instance lives.
  if (next === null) next = randomInt(0, BLOCK_CEILING);

  try {
    mkdirSync(dirname(WALLET_CURSOR), { recursive: true });
    writeFileSync(WALLET_CURSOR, JSON.stringify({ nextBlock: next + 1 }), "utf8");
    return (next % BLOCK_CEILING) * WALLET_BLOCK;
  } catch {
    // Read-only filesystem: the cursor cannot be advanced, so the block has to come from
    // somewhere that does not need to be written down.
    //
    // A start-time offset is not enough here. Seconds since the epoch modulo any window
    // wraps, and two campaigns that land on the same value derive the same addresses; the
    // second one then reverts with AgentExists() the moment it tries to register, because
    // those agents are already on chain from the earlier run. Wall-clock time also repeats
    // across instances that boot together behind a load balancer.
    //
    // So draw the block at random instead. Collision stops depending on when a campaign
    // started and becomes a birthday problem over the whole space: a few thousand campaigns
    // still sit far below a percent. The in-process counter stays on top of it so repeated
    // campaigns inside one instance step strictly forward, which random draws alone would
    // not guarantee.
    //
    // The ceiling is BIP-32's, not ours: a non-hardened `addressIndex` has to stay under
    // 2^31, and every index in this block is `block * WALLET_BLOCK + n`. Drawing from
    // BLOCK_CEILING keeps the largest index derivable — go past it and viem throws instead
    // of handing back a wallet.
    const processOffset = randomInt(0, BLOCK_CEILING);
    return ((processOffset + blocksClaimedThisProcess++) % BLOCK_CEILING) * WALLET_BLOCK;
  }
}

/**
 * Where one user's campaign is snapshotted.
 *
 * A Privy DID looks like `did:privy:clx…`, which is not a filename, so it is reduced to a
 * hash. Two users can never collide on a path, and the id itself does not end up on disk.
 */
function snapshotFor(userId: string): string {
  const safe =
    userId === SOLO_USER
      ? "campaign"
      : `campaign-${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;
  return resolve(DATA_DIR, `${safe}.json`);
}

declare global {
  var __darwinSessions: Map<string, Session | null> | undefined;
}

/**
 * One campaign per user, keyed by Privy DID.
 *
 * The map lives on globalThis so Next's dev-server module reloading does not drop everyone's
 * campaign, and each user's snapshot is a separate file, so one person pressing
 * "+ New campaign" cannot wipe another's population.
 */
function sessions(): Map<string, Session | null> {
  if (!globalThis.__darwinSessions) globalThis.__darwinSessions = new Map();
  return globalThis.__darwinSessions;
}

export function getSession(userId: string): Session | null {
  const all = sessions();
  if (!all.has(userId)) all.set(userId, restore(userId));
  return all.get(userId) ?? null;
}

export function requireSession(userId: string): Session {
  const s = getSession(userId);
  if (!s) throw new Error("No campaign yet. Create one at / first.");
  return s;
}

export async function startCampaign(
  userId: string,
  input: CampaignInput,
): Promise<Session> {
  // Agent numbering restarts with each campaign, so the labels a judge reads on the
  // dashboard are A01…A12 and not whatever the previous run happened to leave behind.
  resetAgentCounter();
  const { campaign, market } = createCampaign(input);

  const cfg = configFromEnv();
  const session: Session = {
    campaign,
    market,
    rng: mulberry32(campaign.seed ^ 0x5eed),
    bridge: cfg ? new ChainBridge(cfg) : null,
    adPlatform: createAdPlatform(market, campaign.seed),
    walletIndex: new Map(),
    nextWalletIndex: claimWalletBlock(),
  };

  for (const agent of campaign.agents) {
    session.walletIndex.set(agent.id, session.nextWalletIndex++);
  }

  sessions().set(userId, session);
  persist(userId);
  return session;
}

export function endCampaign(userId: string): void {
  sessions().set(userId, null);
  try {
    writeFileSync(snapshotFor(userId), "null", "utf8");
  } catch {
    // A read-only filesystem (Vercel) just means no snapshot; the session still works.
  }
}

/**
 * Find whoever owns the agent behind a tracking link.
 *
 * The storefront is public — a visitor who clicked an ad has no account and cannot say
 * which campaign they came from — so the id itself has to locate the session. Tracking ids
 * are random per agent, so this is a lookup, not a guess.
 *
 * Only sessions already loaded in this process are searched; a campaign whose snapshot has
 * not been touched since boot is not found. In practice the campaign serving live ads is
 * the one running, and the page already handles "this link has expired".
 */
export function sessionByTracking(
  tracking: string,
): { userId: string; session: Session } | null {
  // Single-user mode keeps everything under one id whose snapshot may not have been read
  // yet on a cold start, so load it before looking.
  getSession(SOLO_USER);

  for (const [userId, session] of sessions()) {
    if (!session) continue;
    if (session.campaign.agents.some((a) => a.trackingId === tracking))
      return { userId, session };
  }
  return null;
}

/** Assign a wallet slot to an agent born after the campaign started. */
export function walletIndexFor(session: Session, agentId: string): number {
  const existing = session.walletIndex.get(agentId);
  if (existing !== undefined) return existing;

  const index = session.nextWalletIndex++;
  session.walletIndex.set(agentId, index);
  return index;
}

export function chainConfig(): ChainConfig | null {
  return configFromEnv();
}

export function persist(userId: string): void {
  const session = sessions().get(userId);
  if (!session) return;
  try {
    mkdirSync(dirname(snapshotFor(userId)), { recursive: true });
    writeFileSync(
      snapshotFor(userId),
      JSON.stringify(
        {
          campaign: session.campaign,
          walletIndex: [...session.walletIndex.entries()],
          nextWalletIndex: session.nextWalletIndex,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Serverless filesystems are read-only. Losing the snapshot is survivable.
  }
}

function restore(userId: string): Session | null {
  try {
    const raw = readFileSync(snapshotFor(userId), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.campaign) return null;

    const campaign = parsed.campaign as Campaign;
    const cfg = configFromEnv();
    const restoredIndices: number[] = (parsed.walletIndex ?? []).map(
      (entry: [string, number]) => entry[1],
    );

    return {
      campaign,
      market: createMarket(campaign.product, campaign.seed),
      // The generator's internal state is not serialisable; a restart re-seeds it. The
      // campaign's money and lineage are unaffected, only the next noise draw differs.
      rng: mulberry32((campaign.seed ^ 0x5eed) + campaign.tick),
      bridge: cfg ? new ChainBridge(cfg) : null,
      // Campaign ids on agents survive the snapshot; the platform's own counters do not.
      adPlatform: createAdPlatform(
        createMarket(campaign.product, campaign.seed),
        campaign.seed,
      ),
      walletIndex: new Map(parsed.walletIndex ?? []),
      // Fall back to the high-water mark of the restored map, never to a bare agent count:
      // that would restart numbering inside a block another campaign already used.
      nextWalletIndex:
        parsed.nextWalletIndex ??
        Math.max(0, ...restoredIndices, -1) + 1,
    };
  } catch {
    return null;
  }
}

export type { Session };
