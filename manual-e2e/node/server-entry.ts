// Node HTTP host entry for the manual end-to-end check (the S3 path,
// or R2 via the S3-compat endpoint — see manual-e2e/README.md). This
// is a skeleton — not a production template. It exists so a maintainer
// can deploy `createListener()` against real S3 / R2 and run the check
// at `manual-e2e/node/e2e.test.ts`. Production users scaffold via
// `create-baerly` instead.
//
// Reads env vars, constructs `S3HttpStorage` against real AWS S3
// (or R2 via the S3-compat endpoint — see manual-e2e/README.md), wires
// a sharedSecret `Verifier`, and binds the `node:http` listener to
// PORT.

import { createServer } from "node:http";
import { DOMParser } from "@xmldom/xmldom";
import { AwsClient } from "aws4fetch";
import { createListener, S3HttpStorage } from "@baerly/adapter-node";
import { sharedSecret } from "@baerly/server";

const reqEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
};

const APP = process.env["APP"] ?? "e2e";
const TENANT = process.env["TENANT"] ?? "default";
const PORT = Number(process.env["PORT"] ?? "8080");

const accessKeyId = reqEnv("AWS_ACCESS_KEY_ID");
const secretAccessKey = reqEnv("AWS_SECRET_ACCESS_KEY");
const region = process.env["AWS_REGION"] ?? "us-east-1";
const bucket = reqEnv("BUCKET");
const endpoint = process.env["S3_ENDPOINT"] ?? `https://s3.${region}.amazonaws.com`;
const sharedSecretValue = reqEnv("SHARED_SECRET");

const aws = new AwsClient({
  accessKeyId,
  secretAccessKey,
  region,
  service: "s3",
});

const storage = new S3HttpStorage({
  endpoint,
  bucket,
  xmlParser: new DOMParser(),
  sign: (req) => aws.sign(req),
});

// Productized `Verifier` from `@baerly/server` — same accept/reject
// shape as the prior inline verifier, plus constant-time
// secret compare and config-error throws for empty inputs. See
// `packages/server/src/auth/presets/shared-secret.ts`.
const listener = createListener({
  app: APP,
  storage,
  verifier: sharedSecret({ secret: sharedSecretValue, tenantPrefix: TENANT }),
});

const server = createServer(listener);
server.listen(PORT, () => {
  // Single-line readiness log; container orchestrators key off it
  // for "ready" detection in the manual check. No prom/otel here — Phase
  // 8 wires the production observability story.
  console.log(`baerly-e2e-node listening on :${PORT}`);
});

// Graceful shutdown — not production-ready, but enough that the
// the manual check's `docker stop` doesn't drop in-flight long-polls.
const shutdown = (sig: NodeJS.Signals): void => {
  console.log(`Received ${sig}; closing server`);
  server.close((err) => {
    if (err) {
      console.error("server.close error", err);
      process.exit(1);
    }
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
