/** Corrective action for a `sharedSecret(...)` preset misconfig; crosses the wire. */
export const SHARED_SECRET_CONFIG_RESOLUTION: string =
  'Pass a non-empty `secret` and a non-empty `tenantPrefix` with no "/" to sharedSecret({ secret, tenantPrefix }).';

/** Corrective action for a `bearerJwt(...)` preset misconfig; crosses the wire. */
export const BEARER_JWT_CONFIG_RESOLUTION: string =
  'Provide non-empty `issuer`, `audience`, and at least one `algorithms` entry; `tenantClaim` and `tenantPrefix` are mutually exclusive and `tenantPrefix` must be non-empty with no "/"; `clockSkewMs` and `jwksCacheTtlMs`, when set, must be >= 0.';

/** Corrective action for a `cloudflareAccess(...)` preset misconfig; crosses the wire. */
export const CLOUDFLARE_ACCESS_CONFIG_RESOLUTION: string =
  'Pass a bare team name as `teamDomain` (lowercase letters, digits and "-", e.g. `acme`) and a 64-char lowercase-hex `audienceTag` (the Application Audience (AUD) tag from the CF Access app config).';

/**
 * Accepted form of a Cloudflare Access `teamDomain`: the bare team name
 * (`acme`), not the `acme.cloudflareaccess.com` host. The
 * `cloudflareAccess` preset interpolates it into the JWKS host
 * `https://<teamDomain>.cloudflareaccess.com`, so a `/`, `@`, `.` or `:`
 * could point the key fetch at another host. Shared by the preset, the
 * CLI config loader and `baerly doctor` so all three accept the same set.
 *
 * Sited here rather than in `constants.ts`: this module is already in
 * the `auth.js` closure, and importing `constants.ts` from the preset
 * would add about 0.6 KB min-gz to it.
 */
export const CF_ACCESS_TEAM_NAME_PATTERN: RegExp = /^[a-z0-9-]+$/;
