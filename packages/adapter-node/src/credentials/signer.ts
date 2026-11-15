import { AwsClient } from "aws4fetch";
import type { Credentials, CredentialsProvider } from "./types.ts";
import { credentialResolver } from "./resolve.ts";

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

  const resolve = credentialResolver(opts.credentials, now, (creds) =>
    buildAwsClient(creds, region),
  );

  return async (req) => {
    const aws = await resolve();
    return aws.sign(req);
  };
}
