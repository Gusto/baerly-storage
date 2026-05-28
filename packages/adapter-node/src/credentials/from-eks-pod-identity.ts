import { readFile as fsReadFile } from "node:fs/promises";
import { BaerlyError } from "@baerly/protocol";
import type { CredentialsProvider } from "./types.ts";

const FETCH_TIMEOUT_MS = 2_000;

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
    if (tokenPath === undefined || tokenPath === "") {
      throw new BaerlyError(
        "InvalidConfig",
        "fromEksPodIdentity: AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE not set",
      );
    }

    const rawToken = await doReadFile(tokenPath, "utf8");
    const token = rawToken.trim();

    let res: Response;
    try {
      res = await doFetch(uri, {
        method: "GET",
        headers: { Authorization: token },
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
    // PERMANENT_ERROR_CODES in s3-http.ts).
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
    return {
      accessKeyId: json.AccessKeyId,
      secretAccessKey: json.SecretAccessKey,
      sessionToken: json.Token,
      expiration: new Date(json.Expiration),
    };
  };
}
