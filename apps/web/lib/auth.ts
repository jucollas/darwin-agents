import { PrivyClient } from "@privy-io/node";

/**
 * Who is asking.
 *
 * Every campaign belongs to exactly one logged-in user, so every route that reads or
 * changes one has to know which user is on the other end. The browser sends a Privy access
 * token; this verifies it against Privy's key rather than believing the claim, and hands
 * back the user's DID to key their session by.
 *
 * Without PRIVY_APP_ID / PRIVY_APP_SECRET the app runs in single-user mode: everyone shares
 * one campaign, exactly as it behaved before login existed. That keeps `npm run dev` and the
 * headless sim working with no accounts to set up.
 */

/** The id a session is filed under when no login is configured. */
export const SOLO_USER = "solo";

let client: PrivyClient | null = null;

export function authConfigured(): boolean {
  return Boolean(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
}

function privy(): PrivyClient | null {
  if (!authConfigured()) return null;
  if (!client) {
    client = new PrivyClient({
      appId: process.env.PRIVY_APP_ID as string,
      appSecret: process.env.PRIVY_APP_SECRET as string,
      // Skips a round trip to Privy on every request when the key is pasted into .env.
      ...(process.env.PRIVY_VERIFICATION_KEY
        ? { jwtVerificationKey: process.env.PRIVY_VERIFICATION_KEY }
        : {}),
    });
  }
  return client;
}

/**
 * The Privy DID of the caller, or null if the token is missing or does not verify.
 *
 * When login is not configured this returns SOLO_USER, so the routes have one code path
 * instead of branching on whether accounts exist.
 */
export async function userFrom(request: Request): Promise<string | null> {
  const p = privy();
  if (!p) return SOLO_USER;

  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;

  try {
    // v0.34 takes the token as a bare string and returns snake_case claims; the docs show
    // an older shape, so this follows the installed types.
    const claims = await p.utils().auth().verifyAccessToken(token);
    return claims.user_id ?? null;
  } catch {
    // Expired, tampered with, or issued for another app. None of those are our user.
    return null;
  }
}

/** The 401 body, so every route refuses in the same words. */
export const UNAUTHORIZED = {
  error: "Sign in to run a campaign of your own.",
} as const;
