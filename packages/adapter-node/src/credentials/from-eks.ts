import { BaerlyError } from "@baerly/protocol";
import { fromEksPodIdentity } from "./from-eks-pod-identity.ts";
import { fromWebIdentity } from "./from-web-identity.ts";
import type { CredentialsProvider } from "./types.ts";

/**
 * Resolve AWS credentials on EKS regardless of which identity mechanism the
 * cluster uses, so callers don't have to know. EKS injects credentials one of
 * two ways:
 *
 * - **Pod Identity** (2023+): `AWS_CONTAINER_CREDENTIALS_FULL_URI` +
 *   `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` → {@link fromEksPodIdentity}.
 * - **IRSA** (web-identity token): `AWS_ROLE_ARN` +
 *   `AWS_WEB_IDENTITY_TOKEN_FILE` → {@link fromWebIdentity}.
 *
 * Detection runs on every resolve (Pod Identity preferred when both are
 * present), so the right mechanism is picked even if the env is populated late
 * and re-checked on each refresh. Use this instead of the mechanism-specific
 * providers unless you have a reason to pin one.
 */
export function fromEks(
  opts: {
    fetch?: typeof fetch;
    readFile?: (path: string, encoding: "utf8") => Promise<string>;
  } = {},
): CredentialsProvider {
  const podIdentity = fromEksPodIdentity(opts);
  const webIdentity = fromWebIdentity(opts);

  return async () => {
    const uri = process.env["AWS_CONTAINER_CREDENTIALS_FULL_URI"];
    const tokenFile = process.env["AWS_WEB_IDENTITY_TOKEN_FILE"];
    if (uri !== undefined && uri !== "") {
      return podIdentity();
    }
    if (tokenFile !== undefined && tokenFile !== "") {
      return webIdentity();
    }
    throw new BaerlyError(
      "InvalidConfig",
      "fromEks: no EKS credentials in env — set AWS_CONTAINER_CREDENTIALS_FULL_URI " +
        "(Pod Identity) or AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN (IRSA)",
    );
  };
}
