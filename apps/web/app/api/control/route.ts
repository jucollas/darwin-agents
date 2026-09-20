import { NextResponse } from "next/server";
import { UNAUTHORIZED, userFrom } from "@/lib/auth";
import { log } from "@/lib/engine";
import { populationStats, profitOf } from "@/lib/evolution";
import { persist, requireSession } from "@/lib/store";
import { type Micro, toUsd } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The human's controls. Everything here has an on-chain counterpart in AgentTreasury —
 * pausing the campaign and re-capping it are owner-only functions there too, so the
 * dashboard is not the only thing standing between an agent and the money.
 */
export async function POST(request: Request) {
  const userId = await userFrom(request);
  if (!userId) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  let session: ReturnType<typeof requireSession>;
  try {
    session = requireSession(userId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }

  const { campaign } = session;
  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const action = String(body.action);

  switch (action) {
    case "pause":
    case "resume": {
      campaign.paused = action === "pause";
      log(
        campaign,
        "human",
        null,
        action === "pause"
          ? "Campaign paused by the operator"
          : "Campaign resumed",
      );
      break;
    }

    case "kill": {
      const agent = campaign.agents.find((a) => a.id === body.agentId);
      if (!agent)
        return NextResponse.json({ error: "No such agent." }, { status: 404 });
      if (agent.status === "dead")
        return NextResponse.json(
          { error: "Already shut down." },
          { status: 409 },
        );

      agent.status = "dead";
      agent.diedTick = campaign.tick;
      agent.deathReason = "killed_by_human";
      log(
        campaign,
        "human",
        agent.id,
        `${agent.label} shut down by the operator`,
        profitOf(agent),
      );
      break;
    }

    case "setGlobalCap": {
      const capMicro = Math.round(Number(body.capUsd) * 1_000_000) as Micro;
      if (!Number.isFinite(capMicro) || capMicro < 0) {
        return NextResponse.json(
          { error: "The cap has to be a positive amount." },
          { status: 400 },
        );
      }
      campaign.globalCapMicro = capMicro;
      log(
        campaign,
        "human",
        null,
        `Campaign spending cap set to $${toUsd(capMicro).toFixed(2)}`,
        capMicro,
      );
      break;
    }

    case "setAgentBudget": {
      const agent = campaign.agents.find((a) => a.id === body.agentId);
      if (!agent)
        return NextResponse.json({ error: "No such agent." }, { status: 404 });

      const allowanceMicro = Math.round(Number(body.allowanceUsd) * 1_000_000);
      if (allowanceMicro < agent.spentMicro) {
        return NextResponse.json(
          {
            error: `${agent.label} already spent $${toUsd(agent.spentMicro).toFixed(2)}.`,
          },
          { status: 400 },
        );
      }
      agent.allowanceMicro = allowanceMicro;
      log(
        campaign,
        "human",
        agent.id,
        `${agent.label} budget set to $${toUsd(allowanceMicro).toFixed(2)}`,
      );
      break;
    }

    case "setFitness": {
      campaign.evolution.weights = {
        profit: Number(body.profit ?? 1),
        conversionRate: Number(body.conversionRate ?? 0),
        costPerAcquisition: Number(body.costPerAcquisition ?? 0),
      };
      log(campaign, "human", null, "Fitness function reweighted");
      break;
    }

    default:
      return NextResponse.json(
        { error: `Unknown action "${action}".` },
        { status: 400 },
      );
  }

  persist(userId);
  return NextResponse.json({
    ok: true,
    paused: campaign.paused,
    stats: populationStats(campaign),
  });
}
