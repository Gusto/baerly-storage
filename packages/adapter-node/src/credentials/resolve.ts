import type { Credentials, CredentialsProvider } from "./types.ts";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** A cached credential-derived value that can be dropped before its expiration. */
export type CredentialResolver<T> = (() => Promise<T>) & {
  /**
   * Drop `value` from the cache so the next resolve calls the provider again.
   * A no-op unless `value` is the cached one, so concurrent callers that all
   * saw the same rejected value cause one refresh, not one each.
   */
  invalidate(value: T): void;
};

/** Cache a credential-derived signing value until five minutes before expiration. */
export function credentialResolver<T>(
  credentials: Credentials | CredentialsProvider,
  now: () => number,
  build: (credentials: Credentials) => T,
): CredentialResolver<T> {
  if (typeof credentials !== "function") {
    const value = build(credentials);
    return Object.assign(async () => value, { invalidate() {} });
  }

  let cached: { value: T; expiresAt: number } | null = null;
  let inFlight: Promise<T> | null = null;
  const resolve = async () => {
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
  return Object.assign(resolve, {
    invalidate(value: T) {
      if (cached?.value === value) {
        cached = null;
      }
    },
  });
}
