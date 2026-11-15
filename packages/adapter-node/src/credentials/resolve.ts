import type { Credentials, CredentialsProvider } from "./types.ts";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Cache a credential-derived signing value until five minutes before expiration. */
export function credentialResolver<T>(
  credentials: Credentials | CredentialsProvider,
  now: () => number,
  build: (credentials: Credentials) => T,
): () => Promise<T> {
  if (typeof credentials !== "function") {
    const value = build(credentials);
    return async () => value;
  }

  let cached: { value: T; expiresAt: number } | null = null;
  let inFlight: Promise<T> | null = null;
  return async () => {
    if (cached !== null && cached.expiresAt - REFRESH_BUFFER_MS > now()) {
      return cached.value;
    }
    if (inFlight === null) {
      // Defer the provider so synchronous throws also clear an assigned flight.
      inFlight = Promise.resolve()
        .then(credentials)
        .then((creds) => {
          const value = build(creds);
          cached = { value, expiresAt: creds.expiration?.getTime() ?? Number.POSITIVE_INFINITY };
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}
