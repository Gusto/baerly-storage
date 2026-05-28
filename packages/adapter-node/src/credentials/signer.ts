import { AwsClient } from "aws4fetch";
import type { Credentials, CredentialsProvider } from "./types.ts";

export function refreshingSigner(opts: {
  region: string;
  credentials: Credentials | CredentialsProvider;
  now?: () => number;
}): (req: Request) => Promise<Request> {
  if (typeof opts.credentials !== "function") {
    const aws = new AwsClient({
      accessKeyId: opts.credentials.accessKeyId,
      secretAccessKey: opts.credentials.secretAccessKey,
      sessionToken: opts.credentials.sessionToken,
      region: opts.region,
      service: "s3",
    });
    return (req) => aws.sign(req);
  }
  throw new Error("provider path: implemented in Task 3");
}
