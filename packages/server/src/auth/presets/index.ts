/**
 * Preset Verifier factories shared across both adapters.
 * Re-exported from `baerly-storage` so day-1 deploy templates wire
 * auth from a one-liner. See each factory's docstring for usage.
 */
export { sharedSecret, type SharedSecretOptions } from "./shared-secret.ts";
export {
  bearerJwt,
  type BearerJwtOptions,
  type JwksDocument,
  type Jwk,
  type JwtAlgorithm,
} from "./bearer-jwt.ts";
export { cloudflareAccess, type CloudflareAccessOptions } from "./cloudflare-access.ts";
