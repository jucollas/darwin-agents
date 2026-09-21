import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { SOLO_USER } from "@/lib/auth";
import { getSession } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Why a campaign does or does not survive between invocations, and which derivation block
 * this instance handed it.
 *
 * The block is the interesting number: AgentTreasury keys agents by address globally, so two
 * instances that draw the same block re-derive the same wallets and registerAgent reverts
 * with AgentExists(). Seeing the block from outside is the difference between diagnosing
 * that and guessing at it.
 */
export async function GET() {
  const dir = process.env.VERCEL ? "/tmp/darwin" : "data";
  const snap = `${dir}/campaign.json`;
  const cursor = `${dir}/wallet-cursor.json`;

  let write: string;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/_probe`, "ok", "utf8");
    write = "writable";
  } catch (e) {
    write = `FAILED: ${(e as Error).message}`;
  }

  const session = getSession(SOLO_USER);
  const indices = session ? [...session.walletIndex.values()] : [];

  return NextResponse.json({
    vercelEnv: process.env.VERCEL ?? null,
    cwd: process.cwd(),
    dir,
    dirWritable: write,
    snapshotExists: existsSync(snap),
    snapshotBytes: existsSync(snap) ? readFileSync(snap, "utf8").length : 0,
    // Present means the cursor path works and blocks are sequential; missing means the
    // random fallback is in play, which is the normal case on Vercel.
    cursorExists: existsSync(cursor),
    cursorValue: existsSync(cursor) ? readFileSync(cursor, "utf8") : null,
    session: session ? "present" : "none",
    walletIndices: indices.slice(0, 8),
    derivationBlock: indices.length ? Math.floor(Math.min(...indices) / 256) : null,
    chainCampaignId: session?.campaign.chain?.campaignId ?? null,
  });
}
