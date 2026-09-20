import type { Address } from "viem";
import { NextResponse } from "next/server";
import { explorerAddress, explorerTx, genomeHash } from "@/lib/chain";
import { log } from "@/lib/engine";
import { remainingAllowance } from "@/lib/evolution";
import {
  chainConfig,
  persist,
  requireSession,
  walletIndexFor,
} from "@/lib/store";
import { toUsd } from "@/lib/types";
import { encodePayment, networkName } from "@/lib/x402";

export const dynamic = "force-dynamic";
// Vercel's Hobby plan caps a function at 60s; asking for more fails the deploy. Six round
// trips to a testnet fit well inside that, and locally there is no limit either way.
export const maxDuration = 60;

/**
 * One agent, all the way through the real thing, on a real chain — streamed.
 *
 *   1. the campaign is funded in AgentTreasury
 *   2. the agent gets its own wallet and a budget the contract knows about
 *   3. it asks the ad exchange for inventory   -> 402 Payment Required
 *   4. it signs spend() itself                 -> money leaves its wallet, under its ceiling
 *   5. it retries with the X-PAYMENT proof     -> 200, inventory served
 *   6. it asks for more than it is allowed     -> the chain refuses
 *
 * The steps are streamed as newline-delimited JSON rather than returned together, because
 * each one is a real round trip to a testnet and the screen is worth more showing them land
 * one at a time than showing a spinner for twenty seconds.
 */

/** What a step looks like on the wire. `narrative` is the sentence shown under the title. */
type Step = {
  step: string;
  detail: string;
  narrative: string;
  actor: "operator" | "agent" | "exchange" | "contract";
  txUrl?: string;
  txHash?: string;
  address?: string;
  ok: boolean;
};

export async function POST(request: Request) {
  const cfg = chainConfig();
  if (!cfg) {
    return NextResponse.json(
      {
        error:
          "No chain configured. Deploy the contracts and fill TREASURY_ADDRESS / TOKEN_ADDRESS in .env.",
      },
      { status: 503 },
    );
  }

  let session: ReturnType<typeof requireSession>;
  try {
    session = requireSession();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }

  const bridge = session.bridge;
  if (!bridge)
    return NextResponse.json({ error: "No chain bridge." }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const { campaign } = session;
  const agent =
    campaign.agents.find((a) => a.id === body.agentId) ??
    campaign.agents.find((a) => a.status === "alive");
  if (!agent)
    return NextResponse.json(
      { error: "No living agent to prove with." },
      { status: 409 },
    );

  const index = walletIndexFor(session, agent.id);
  const payTo = (process.env.AD_NETWORK_ADDRESS ??
    "0x000000000000000000000000000000000000dEaD") as Address;
  const origin = new URL(request.url).origin;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // A closed browser tab should not turn into an unhandled rejection that masks the
      // real outcome; the transactions have already happened on chain either way.
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          // The reader is gone. Keep going so the run finishes and persists.
        }
      };
      const step = (s: Step) => send({ type: "step", step: s });

      try {
        send({
          type: "start",
          agentId: agent.id,
          label: agent.label,
          strategy: agent.genome,
          chain: cfg.chain.name,
          chainId: cfg.chain.id,
          treasury: cfg.treasury,
          treasuryUrl: explorerAddress(cfg, cfg.treasury),
          token: cfg.token,
        });

        const blocked = await chainDiagnostics(bridge, cfg);
        if (blocked) {
          step({
            step: "Cannot reach the chain",
            detail: blocked,
            narrative:
              "Nothing below this point is simulated, so when the chain is unreachable the run stops here rather than pretending.",
            actor: "contract",
            ok: false,
          });
          return;
        }

        // 1 — the campaign exists on chain
        if (!campaign.chain.campaignId) {
          const opened = await bridge.openCampaign({
            fundingMicro: campaign.budgetMicro,
            globalCapMicro: campaign.globalCapMicro,
            epochSeconds: 60,
          });
          campaign.chain = {
            chainId: cfg.chain.id,
            treasury: cfg.treasury,
            token: cfg.token,
            campaignId: opened.campaignId.toString(),
            explorer: cfg.chain.blockExplorers?.default.url ?? null,
            live: true,
          };
          const hash = opened.hashes[opened.hashes.length - 1];
          step({
            step: "The budget is handed to the contract",
            detail: `$${toUsd(campaign.budgetMicro).toFixed(2)} deposited · hard cap $${toUsd(campaign.globalCapMicro).toFixed(2)}`,
            narrative:
              "The money stops being a number in our database. From here the agents can only reach it through AgentTreasury, which counts every token against four separate ceilings.",
            actor: "operator",
            txUrl: explorerTx(cfg, hash),
            txHash: hash,
            ok: true,
          });
        } else {
          step({
            step: "The budget is already held by the contract",
            detail: `campaign #${campaign.chain.campaignId} · cap $${toUsd(campaign.globalCapMicro).toFixed(2)}`,
            narrative:
              "This campaign was funded on chain earlier in the session. The treasury still holds the money and still enforces the same ceilings.",
            actor: "operator",
            txUrl: explorerAddress(cfg, cfg.treasury),
            ok: true,
          });
        }
        const campaignId = BigInt(campaign.chain.campaignId ?? "1");

        // 2 — the agent gets a wallet and a budget the contract knows about
        if (!agent.address) {
          const registered = await bridge.registerAgent({
            campaignId,
            index,
            allowanceMicro: remainingAllowance(agent),
            epochCapMicro: agent.epochCapMicro,
            genome: agent.genome,
          });
          agent.address = registered.address;
          agent.txs.push({
            kind: "register",
            hash: registered.hash,
            amountMicro: remainingAllowance(agent),
            memo: genomeHash(agent.genome),
            tick: campaign.tick,
          });
          step({
            step: `${agent.label} gets its own wallet`,
            detail: registered.address,
            narrative: `Not an account in our app — a real address on ${cfg.chain.name}, holding its own key. The contract records what this address may spend in total and per epoch, plus the hash of the strategy it is betting on.`,
            actor: "agent",
            address: registered.address,
            txUrl: explorerTx(cfg, registered.hash),
            txHash: registered.hash,
            ok: true,
          });
        } else {
          step({
            step: `${agent.label} already holds a wallet`,
            detail: agent.address,
            narrative: `This address was registered earlier. It owns its own key, and every spend below is signed by it rather than by our backend.`,
            actor: "agent",
            address: agent.address,
            txUrl: explorerAddress(cfg, agent.address),
            ok: true,
          });
        }

        const spendable = await bridge.spendableNow(index);
        const priceMicro =
          Number(spendable) > 0
            ? Math.min(Number(spendable), agent.epochCapMicro)
            : 0;
        if (priceMicro <= 0) {
          // Spending the epoch cap is the demo working, not failing — the ceiling the
          // contract enforces is exactly what the next step was going to prove.
          step({
            step: `${agent.label} has already spent its ceiling this epoch`,
            detail:
              "AgentTreasury will not release another token until the epoch rolls over.",
            narrative:
              "This refusal is the same one the last step is built to show. The agent is not out of money — it is out of permission, and no amount of prompting moves that line.",
            actor: "contract",
            ok: true,
          });
          persist();
          send({ type: "done", agentId: agent.id, address: agent.address });
          return;
        }

        // 3 — ask the exchange, get refused
        const quoteResponse = await fetch(`${origin}/api/services/ads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId: agent.id, priceMicro }),
        });
        const quote = await quoteResponse.json();
        step({
          step: "The ad exchange answers 402 Payment Required",
          detail: `${quote?.accepts?.[0]?.description ?? "inventory"} — $${toUsd(priceMicro).toFixed(2)} in mUSD`,
          narrative:
            "No API key, no invoice, no account. The exchange quotes a price over HTTP and refuses to serve anything until it has been paid — the agent has to discover the cost and decide for itself.",
          actor: "exchange",
          ok: quoteResponse.status === 402,
        });

        // 4 — the agent pays, signing with its own key
        const spendTx = await bridge.spend(
          index,
          payTo,
          priceMicro,
          `x402:${agent.trackingId}`,
        );
        agent.spentMicro += priceMicro;
        agent.txs.push({
          kind: "spend",
          hash: spendTx,
          amountMicro: priceMicro,
          memo: "x402 settlement",
          tick: campaign.tick,
        });
        step({
          step: `${agent.label} signs the payment itself`,
          detail: `$${toUsd(priceMicro).toFixed(2)} through AgentTreasury.spend()`,
          narrative: `The transaction is signed by the agent's own key, so the contract reads msg.sender and checks this agent's ceilings — it never takes our backend's word for who is spending.`,
          actor: "agent",
          address: agent.address ?? undefined,
          txUrl: explorerTx(cfg, spendTx),
          txHash: spendTx,
          ok: true,
        });

        // 5 — retry with proof, get the goods
        const paid = await fetch(`${origin}/api/services/ads`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-payment": encodePayment({
              x402Version: 1,
              scheme: "exact",
              network: networkName(cfg.chain.id),
              payload: {
                txHash: spendTx as `0x${string}`,
                from: agent.address as Address,
                amount: String(priceMicro),
                memo: `x402:${agent.trackingId}`,
              },
            }),
          },
          body: JSON.stringify({ agentId: agent.id, priceMicro }),
        });
        const served = await paid.json();
        step({
          step: "The payment checks out, the inventory is served",
          detail: paid.ok
            ? `${served.inventory.impressions.toLocaleString()} impressions on ${served.inventory.platform}`
            : (served.error ?? "rejected"),
          narrative:
            "The exchange does not trust the receipt it was handed. It pulls the transaction back off the chain and reads the Spent event: right payer, right payee, right amount — then it serves.",
          actor: "exchange",
          txUrl: explorerTx(cfg, spendTx),
          ok: paid.ok,
        });

        if (paid.ok) {
          agent.impressions += served.inventory.impressions;
        }

        // 6 — the part that cannot be talked around
        const overspend =
          Number(await bridge.spendableNow(index)) +
          agent.epochCapMicro +
          1_000_000;
        try {
          await bridge.spend(index, payTo, overspend, "overspend attempt");
          step({
            step: "Overspend attempt",
            detail: "It went through. That is a bug.",
            narrative:
              "The contract was supposed to refuse this. If you are seeing it, the ceiling is not being enforced and the claim above is false.",
            actor: "contract",
            ok: false,
          });
        } catch (e) {
          step({
            step: `${agent.label} asks for $${toUsd(overspend).toFixed(2)} and is refused`,
            detail: revertReason(e),
            narrative:
              "This is the whole argument. The agent genuinely tried to overspend and the network threw the transaction out — the limit is not a prompt, a policy or a code review. It is a require() that reverts.",
            actor: "contract",
            ok: true,
          });
        }

        log(
          campaign,
          "chain",
          agent.id,
          `${agent.label} completed an on-chain x402 settlement`,
        );
        persist();
        send({ type: "done", agentId: agent.id, address: agent.address });
      } catch (e) {
        step({
          step: "Stopped",
          detail: failureReason(e),
          narrative:
            "The run talks to a live testnet, so it can fail the way live things fail. Nothing here is faked to keep the sequence looking complete.",
          actor: "contract",
          ok: false,
        });
        persist();
      } finally {
        // The only close in the function: the success path, the early returns and the
        // catch all fall through to here. Closing twice throws, and so does closing a
        // stream whose reader has already gone away when the browser navigates off.
        try {
          controller.close();
        } catch {
          // Already closed or cancelled — nothing left to tell the client either way.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
    },
  });
}

/**
 * A short, actionable line for each way the chain can refuse us.
 *
 * The old message said only "the RPC node did not answer", which was true for exactly one
 * of these and misleading for the rest — a wrong chain id, an unfunded wallet and an
 * undeployed treasury all looked identical from the outside.
 */
async function chainDiagnostics(
  bridge: { publicClient: { getChainId: () => Promise<number>; getBalance: (a: { address: `0x${string}` }) => Promise<bigint>; getBytecode: (a: { address: `0x${string}` }) => Promise<string | undefined> } },
  cfg: { chain: { id: number }; rpcUrl: string; treasury: `0x${string}` },
): Promise<string | null> {
  let chainId: number;
  try {
    chainId = await bridge.publicClient.getChainId();
  } catch {
    return `No answer from ${cfg.rpcUrl}. Check RPC_URL and that the network is reachable.`;
  }
  if (chainId !== cfg.chain.id)
    return `Connected to chain ${chainId}, but CHAIN_ID says ${cfg.chain.id}. Point RPC_URL at the right network.`;

  const code = await bridge.publicClient
    .getBytecode({ address: cfg.treasury })
    .catch(() => undefined);
  if (!code || code === "0x")
    return `No contract at TREASURY_ADDRESS (${cfg.treasury}) on chain ${chainId}. Deploy it, or fix the address.`;

  return null;
}

function failureReason(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  const reverted = revertReason(e);
  if (reverted !== message.split("\n")[0]) return reverted;

  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|socket hang up|HTTP request failed/i.test(message)) {
    return "The RPC node did not answer. Check RPC_URL and that the network is up.";
  }
  if (/insufficient funds/i.test(message)) {
    return "The operator wallet is out of native gas on this network.";
  }
  return message.split("\n")[0];
}

/** Pull the custom error name out of a viem revert, which is what a judge wants to read. */
function revertReason(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  const match = message.match(
    /(AllowanceExceeded|EpochCapExceeded|GlobalCapExceeded|CampaignPaused|AgentDead|AgentExists|AgentUnknown|CampaignUnknown|NotOwner|InsufficientTreasury|ZeroAddress)/,
  );
  return match ? `reverted with ${match[1]}` : message.split("\n")[0];
}
