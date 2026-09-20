import { BuyPanel } from "@/components/BuyPanel";
import { sessionByTracking } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * The landing page every agent's tracking link points at. A purchase here is a real
 * conversion attributed to the agent that brought the visitor, which is how an agent's
 * revenue stops being a self-reported number.
 */
export default async function BuyPage({
  params,
}: {
  params: Promise<{ tracking: string }>;
}) {
  const { tracking } = await params;
  // Public page: the tracking id, not a login, says whose campaign this ad belongs to.
  const session = sessionByTracking(tracking)?.session ?? null;
  const agent =
    session?.campaign.agents.find((a) => a.trackingId === tracking) ?? null;
  const product = session?.campaign.product ?? null;

  if (!session || !agent || !product) {
    return (
      <main style={{ maxWidth: 560, margin: "0 auto", padding: "5rem 1rem" }}>
        <h1 style={{ fontSize: "2rem" }}>This link has expired</h1>
        <p style={{ color: "var(--ink-soft)", marginTop: "0.75rem" }}>
          The campaign behind it is no longer running.
        </p>
      </main>
    );
  }

  return (
    <BuyPanel
      tracking={tracking}
      agentLabel={agent.label}
      strategy={agent.genome}
      product={{ name: product.name, priceUsd: product.priceUsd }}
    />
  );
}
