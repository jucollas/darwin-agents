"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useCallback } from "react";

/** Whether login is wired up. Inlined at build time, so it never changes at runtime. */
export const AUTH_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

/**
 * `fetch` with the caller's identity attached.
 *
 * Every campaign route needs to know who is asking, so the access token rides along on each
 * request. Privy refreshes it when it is close to expiring, so this asks for it per call
 * rather than holding a copy that can go stale mid-demo.
 *
 * Without a Privy app id there is no provider to read from and no token to send; the server
 * then treats every request as the single shared user, which is how the app behaved before
 * accounts existed.
 */
export function useApi() {
  // Safe despite the conditional: AUTH_ENABLED is a build-time constant, so a given bundle
  // always takes the same branch and hook order never changes between renders.
  const getAccessToken = AUTH_ENABLED
    ? // eslint-disable-next-line react-hooks/rules-of-hooks
      usePrivy().getAccessToken
    : null;

  return useCallback(
    async (input: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (getAccessToken) {
        try {
          const token = await getAccessToken();
          if (token) headers.set("authorization", `Bearer ${token}`);
        } catch {
          // No token means the request goes out unauthenticated and the route answers 401,
          // which every caller already handles.
        }
      }
      return fetch(input, { ...init, headers });
    },
    [getAccessToken],
  );
}
