import { SetupForm } from "@/components/SetupForm";

export const dynamic = "force-dynamic";

/**
 * Whether this visitor already has a campaign is a question only the browser can answer
 * now: the access token that identifies them lives there, not in a cookie the server reads.
 * SetupForm asks /api/campaign with that token and sends them to the dashboard if one comes
 * back, so the redirect moved into the client rather than disappearing.
 */
export default function Home() {
  return <SetupForm />;
}
