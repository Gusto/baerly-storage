import { readFile as fsReadFile } from "node:fs/promises";
import { BaerlyError } from "@baerly/protocol";
import type { CredentialsProvider } from "./types.ts";
import { readProjectedToken } from "./token-file.ts";

const FETCH_TIMEOUT_MS = 2_000;

/**
 * Hosts the agent can live on: the ECS agent, the EKS Pod Identity agent
 * (IPv4 and IPv6), and loopback. `127.0.0.0/8` is matched separately.
 * WHATWG URL parsing canonicalizes the hostname first, so alternate
 * spellings (`[0:0:0:0:0:0:0:1]`, `2130706433`) compare equal.
 */
const AGENT_HOSTS: ReadonlySet<string> = new Set([
  "169.254.170.2",
  "169.254.170.23",
  "[fd00:ec2::23]",
  "localhost",
  "[::1]",
]);

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isAgentUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  return AGENT_HOSTS.has(url.hostname) || LOOPBACK_V4.test(url.hostname);
}

/**
 * Resolve AWS credentials from the EKS Pod Identity agent (the 2023
 * successor to IRSA). The agent runs on each EKS node and exchanges
 * the pod's projected service-account token for short-lived AWS
 * credentials, so the app just reads the token and asks the agent.
 *
 * Env vars (set by EKS when the pod has an associated IAM role):
 * - `AWS_CONTAINER_CREDENTIALS_FULL_URI` — the agent endpoint
 *   (typically `http://169.254.170.23/v1/credentials`).
 * - `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` — path to the
 *   projected SA token used to authorize the agent request.
 *
 * Both are required. Agent should respond instantly on the node-local
 * link — 2 s timeout protects against hangs.
 *
 * The URI must name the agent: loopback, or the ECS / EKS link-local
 * addresses (the AWS SDK's container-credentials allow-list). Anything
 * else throws `InvalidConfig` before the token file is read, so a
 * misconfigured or injected env var never sends the token off-node.
 */
export function fromEksPodIdentity(
  opts: {
    fetch?: typeof fetch;
    readFile?: (path: string, encoding: "utf8") => Promise<string>;
  } = {},
): CredentialsProvider {
  const doFetch = opts.fetch ?? fetch;
  const doReadFile = opts.readFile ?? fsReadFile;

  return async () => {
    const uri = process.env["AWS_CONTAINER_CREDENTIALS_FULL_URI"];
    const tokenPath = process.env["AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"];
    if (uri === undefined || uri === "") {
      throw new BaerlyError(
        "InvalidConfig",
        "fromEksPodIdentity: AWS_CONTAINER_CREDENTIALS_FULL_URI not set",
      );
    }
    if (!isAgentUri(uri)) {
      throw new BaerlyError(
        "InvalidConfig",
        "fromEksPodIdentity: AWS_CONTAINER_CREDENTIALS_FULL_URI must be an http(s) URL on loopback, 169.254.170.2, 169.254.170.23 or [fd00:ec2::23]",
      );
    }
    if (tokenPath === undefined || tokenPath === "") {
      throw new BaerlyError(
        "InvalidConfig",
        "fromEksPodIdentity: AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE not set",
      );
    }

    const token = await readProjectedToken(doReadFile, tokenPath, {
      provider: "fromEksPodIdentity",
      envVar: "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    });

    let res: Response;
    try {
      res = await doFetch(uri, {
        method: "GET",
        headers: { Authorization: token },
        // The token rides in the Authorization header; a redirect would resend
        // it to the 3xx target. The node-local agent never redirects — refuse
        // rather than follow, so a redirect surfaces as a NetworkError.
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new BaerlyError(
        "NetworkError",
        `fromEksPodIdentity: agent fetch failed (${(error as Error).message})`,
      );
    }

    // 5xx + 429 are transient — bucket as NetworkError so callers /
    // chained providers can retry. Other 4xx are permanent —
    // AccessDenied so retry loops short-circuit (see
    // PERMANENT_STORAGE_ERROR_CODES in @baerly/protocol's storage/retry.ts).
    if (res.status >= 500 || res.status === 429) {
      throw new BaerlyError("NetworkError", `fromEksPodIdentity: agent responded ${res.status}`);
    }
    if (!res.ok) {
      throw new BaerlyError("AccessDenied", `fromEksPodIdentity: agent responded ${res.status}`);
    }

    let json: {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      Token?: string;
      Expiration?: string;
    };
    try {
      json = await res.json();
    } catch (error) {
      throw new BaerlyError(
        "InvalidResponse",
        `fromEksPodIdentity: agent returned non-JSON body (${(error as Error).message})`,
      );
    }
    if (
      json.AccessKeyId === undefined ||
      json.SecretAccessKey === undefined ||
      json.Token === undefined ||
      json.Expiration === undefined
    ) {
      throw new BaerlyError("InvalidResponse", "fromEksPodIdentity: malformed agent response");
    }
    // A present-but-unparseable Expiration is as malformed as a missing field:
    // `new Date(bad)` yields an Invalid Date (getTime() → NaN) rather than
    // throwing, and the signer's `expiresAt - buffer > now()` refresh check is
    // false for NaN — so a bad timestamp would silently defeat credential
    // caching/rotation. Reject it here instead.
    const expiration = new Date(json.Expiration);
    if (Number.isNaN(expiration.getTime())) {
      throw new BaerlyError("InvalidResponse", "fromEksPodIdentity: malformed agent response");
    }
    return {
      accessKeyId: json.AccessKeyId,
      secretAccessKey: json.SecretAccessKey,
      sessionToken: json.Token,
      expiration,
    };
  };
}
