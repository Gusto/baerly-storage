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

/**
 * A SigV4 signer. `invalidate` is present only for a credentials provider:
 * given a request this signer returned, it drops the credentials that signed
 * it so the next `sign` calls the provider again.
 */
export type RefreshingSigner = ((req: Request) => Promise<Request>) & {
  invalidate?: (signed: Request) => void;
};

export function refreshingSigner(opts: {
  region: string;
  credentials: Credentials | CredentialsProvider;
  now?: () => number;
}): RefreshingSigner {
  const region = opts.region;
  const now = opts.now ?? (() => Date.now());

  if (typeof opts.credentials !== "function") {
    const aws = buildAwsClient(opts.credentials, region);
    return (req) => aws.sign(req);
  }

  const resolve = credentialResolver(opts.credentials, now, (creds) =>
    buildAwsClient(creds, region),
  );

  const signedBy = new WeakMap<Request, AwsClient>();
  const sign = async (req: Request): Promise<Request> => {
    const aws = await resolve();
    const signed = await aws.sign(req);
    signedBy.set(signed, aws);
    return signed;
  };
  return Object.assign(sign, {
    invalidate(signed: Request) {
      const aws = signedBy.get(signed);
      if (aws !== undefined) {
        resolve.invalidate(aws);
      }
    },
  });
}
