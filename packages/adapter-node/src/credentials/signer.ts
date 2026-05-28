import { AwsClient } from "aws4fetch";
import type { Credentials, CredentialsProvider } from "./types.ts";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function buildAwsClient(creds: Credentials, region: string): AwsClient {
  return new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    region,
    service: "s3",
  });
}

export function refreshingSigner(opts: {
  region: string;
  credentials: Credentials | CredentialsProvider;
  now?: () => number;
}): (req: Request) => Promise<Request> {
  const region = opts.region;
  const now = opts.now ?? (() => Date.now());

  if (typeof opts.credentials !== "function") {
    const aws = buildAwsClient(opts.credentials, region);
    return (req) => aws.sign(req);
  }

  const provider = opts.credentials;
  let cached: { aws: AwsClient; expiresAt: number } | null = null;

  const resolve = async (): Promise<AwsClient> => {
    if (cached !== null && cached.expiresAt - REFRESH_BUFFER_MS > now()) {
      return cached.aws;
    }
    const creds = await provider();
    const aws = buildAwsClient(creds, region);
    const expiresAt = creds.expiration?.getTime() ?? Number.POSITIVE_INFINITY;
    cached = { aws, expiresAt };
    return aws;
  };

  return async (req) => {
    const aws = await resolve();
    return aws.sign(req);
  };
}
