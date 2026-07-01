import { BaerlyError } from "@baerly/protocol";
import { readFile as fsReadFile } from "node:fs/promises";
import type { CredentialsProvider } from "./types.ts";
import { readProjectedToken } from "./token-file.ts";
import { parseAssumeRoleWithWebIdentity, parseStsError } from "../xml.ts";

// STS is a regional (not node-local) service, so allow more headroom than the
// 2 s Pod Identity agent budget — but still bound it against hangs.
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_SESSION_NAME = "baerly-storage";

/**
 * Resolve AWS credentials via IRSA (IAM Roles for Service Accounts) — the
 * web-identity-token flow, distinct from the EKS Pod Identity agent that
 * {@link fromEksPodIdentity} handles. EKS projects a signed service-account
 * token into the pod and the app exchanges it for short-lived credentials by
 * calling STS `AssumeRoleWithWebIdentity` directly (the token *is* the auth, so
 * the call is unsigned — no chicken-and-egg credential bootstrap).
 *
 * Env vars (set by EKS when the pod's service account is annotated with a role):
 * - `AWS_ROLE_ARN` — the role to assume.
 * - `AWS_WEB_IDENTITY_TOKEN_FILE` — path to the projected SA token.
 * - `AWS_ROLE_SESSION_NAME` — optional session name (defaults to `baerly-storage`).
 * - `AWS_REGION` / `AWS_DEFAULT_REGION` — optional; selects the regional STS
 *   endpoint (falls back to the global endpoint).
 *
 * STS credentials expire (~1 h); the returned provider reports `expiration`, so
 * the signing layer re-resolves before they lapse.
 */
export function fromWebIdentity(
  opts: {
    fetch?: typeof fetch;
    readFile?: (path: string, encoding: "utf8") => Promise<string>;
  } = {},
): CredentialsProvider {
  const doFetch = opts.fetch ?? fetch;
  const doReadFile = opts.readFile ?? fsReadFile;

  return async () => {
    const roleArn = process.env["AWS_ROLE_ARN"];
    const tokenPath = process.env["AWS_WEB_IDENTITY_TOKEN_FILE"];
    const sessionName = process.env["AWS_ROLE_SESSION_NAME"] || DEFAULT_SESSION_NAME;
    const region = process.env["AWS_REGION"] || process.env["AWS_DEFAULT_REGION"];
    if (roleArn === undefined || roleArn === "") {
      throw new BaerlyError("InvalidConfig", "fromWebIdentity: AWS_ROLE_ARN not set");
    }
    if (tokenPath === undefined || tokenPath === "") {
      throw new BaerlyError(
        "InvalidConfig",
        "fromWebIdentity: AWS_WEB_IDENTITY_TOKEN_FILE not set",
      );
    }

    const token = await readProjectedToken(doReadFile, tokenPath, {
      provider: "fromWebIdentity",
      envVar: "AWS_WEB_IDENTITY_TOKEN_FILE",
    });

    // Regional endpoint when a region is known (lower latency, and required in
    // non-default partitions); otherwise the global endpoint.
    const endpoint =
      region !== undefined && region !== ""
        ? `https://sts.${region}.amazonaws.com/`
        : "https://sts.amazonaws.com/";
    const body = new URLSearchParams({
      Action: "AssumeRoleWithWebIdentity",
      Version: "2011-06-15",
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      WebIdentityToken: token,
    }).toString();

    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/xml",
        },
        body,
        // The POST carries the web-identity token as its only auth and is
        // unsigned, so a redirect would resend the token to the 3xx target.
        // STS never legitimately redirects this call — refuse rather than
        // follow, so a redirect surfaces as a NetworkError instead of leaking.
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new BaerlyError(
        "NetworkError",
        `fromWebIdentity: STS fetch failed (${(error as Error).message})`,
      );
    }

    // 5xx + 429 are transient — NetworkError so callers / chained providers can
    // retry. Other 4xx (expired/invalid token, role trust mismatch) are
    // permanent — AccessDenied so retry loops short-circuit (see
    // PERMANENT_ERROR_CODES in s3-http.ts). Either way, fold the STS
    // <ErrorResponse> Code/Message into the message — a bare status turns the
    // exact misconfig this provider exists to debug (bad role trust policy,
    // token audience mismatch, clock skew, expired token) into a guessing game.
    if (!res.ok) {
      const stsErr = parseStsError(await res.text());
      const detail =
        stsErr?.Code !== undefined
          ? ` (${stsErr.Code}${stsErr.Message !== undefined ? `: ${stsErr.Message}` : ""})`
          : "";
      if (res.status >= 500 || res.status === 429) {
        throw new BaerlyError(
          "NetworkError",
          `fromWebIdentity: STS responded ${res.status}${detail}`,
        );
      }
      throw new BaerlyError(
        "AccessDenied",
        `fromWebIdentity: STS responded ${res.status}${detail}`,
      );
    }

    const parsed = parseAssumeRoleWithWebIdentity(await res.text());
    if (
      parsed.AccessKeyId === undefined ||
      parsed.SecretAccessKey === undefined ||
      parsed.SessionToken === undefined ||
      parsed.Expiration === undefined
    ) {
      throw new BaerlyError("InvalidResponse", "fromWebIdentity: malformed STS response");
    }
    // A present-but-unparseable Expiration is as malformed as a missing field:
    // `new Date(bad)` yields an Invalid Date (getTime() → NaN) rather than
    // throwing, and the signer's `expiresAt - buffer > now()` refresh check is
    // false for NaN — so a bad timestamp would silently defeat credential
    // caching/rotation. Reject it here instead.
    const expiration = new Date(parsed.Expiration);
    if (Number.isNaN(expiration.getTime())) {
      throw new BaerlyError("InvalidResponse", "fromWebIdentity: malformed STS response");
    }
    return {
      accessKeyId: parsed.AccessKeyId,
      secretAccessKey: parsed.SecretAccessKey,
      sessionToken: parsed.SessionToken,
      expiration,
    };
  };
}
