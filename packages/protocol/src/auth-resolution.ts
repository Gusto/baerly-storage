/** Corrective action for a `sharedSecret(...)` preset misconfig; crosses the wire. */
export const SHARED_SECRET_CONFIG_RESOLUTION: string =
  'Pass a non-empty `secret` and a non-empty `tenantPrefix` with no "/" to sharedSecret({ secret, tenantPrefix }).';

/** Corrective action for a `bearerJwt(...)` preset misconfig; crosses the wire. */
export const BEARER_JWT_CONFIG_RESOLUTION: string =
  'Provide non-empty `issuer`, `audience`, and at least one `algorithms` entry; `tenantClaim` and `tenantPrefix` are mutually exclusive and `tenantPrefix` must be non-empty with no "/".';

/** Corrective action for a `cloudflareAccess(...)` preset misconfig; crosses the wire. */
export const CLOUDFLARE_ACCESS_CONFIG_RESOLUTION: string =
  "Pass a non-empty `teamDomain` and a 64-char lowercase-hex `audienceTag` (the Application Audience (AUD) tag from the CF Access app config).";
