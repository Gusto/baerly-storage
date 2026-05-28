/**
 * Temporary or static AWS-shaped credentials. Field shape matches
 * `@smithy/types`' `AwsCredentialIdentity` so callers can pass
 * `@aws-sdk/credential-providers` output directly (e.g.
 * `fromTokenFile()`) without an adapter.
 *
 * `expiration` is the absolute time at which `accessKeyId` /
 * `secretAccessKey` / `sessionToken` stop being valid. When present,
 * the signing layer re-resolves credentials some buffer before that
 * time. When absent, credentials are treated as static.
 */
export type Credentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
};

/**
 * Async credential resolver. Called by the signing layer on demand —
 * once on first sign, then again when cached `expiration` is within
 * the refresh buffer. Closure is the natural place to keep retry /
 * fallback / fan-out logic; the signing layer only cares about the
 * resolved shape.
 *
 * **Refresh is driven by `Credentials.expiration`.** If your provider
 * returns no `expiration`, the signer will call this function
 * **exactly once** for the lifetime of the storage handle and reuse
 * those credentials forever. That's the right default for genuinely
 * static creds (e.g. `process.env`), but it's a footgun if you're
 * resolving rotating credentials and forgot to set `expiration` —
 * the first 1 h works, then every request 403s with no retry. Set
 * `expiration` on every refresh-eligible resolve.
 *
 * Implementations should be safe to call concurrently — the signing
 * layer single-flights refresh, but tests and chained providers may
 * call this in parallel.
 */
export type CredentialsProvider = () => Promise<Credentials>;
