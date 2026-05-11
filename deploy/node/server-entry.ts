// Hand-rolled Node entry for the Phase 6 real-deploy gate.
//
// Reads env vars, constructs `S3HttpStorage` against real AWS S3
// (or R2 via the S3-compat endpoint — see deploy/README.md), wires
// a sharedSecret `Verifier`, and binds the `node:http` listener to
// PORT.

import { createServer } from "node:http";
import { DOMParser } from "@xmldom/xmldom";
import { AwsClient } from "aws4fetch";
import { createListener, S3HttpStorage } from "@baerly/adapter-node";
import type { Verifier } from "@baerly/protocol";

const reqEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
};

const APP = process.env.APP ?? "gate";
const TENANT = process.env.TENANT ?? "default";
const PORT = Number(process.env.PORT ?? "8080");

const accessKeyId = reqEnv("AWS_ACCESS_KEY_ID");
const secretAccessKey = reqEnv("AWS_SECRET_ACCESS_KEY");
const region = process.env.AWS_REGION ?? "us-east-1";
const bucket = reqEnv("BUCKET");
const endpoint = process.env.S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`;
const sharedSecret = reqEnv("SHARED_SECRET");

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

/**
 * Inline gate-only `Verifier`. Accepts `Authorization: Bearer
 * <SHARED_SECRET>`; returns `null` for everything else so
 * `createListener` translates the result to a 401 + `MPS3Error{code:
 * "Unauthorized"}` envelope. Phase 8 productizes via a preset factory.
 *
 * `createListener` constructs a WHATWG `Request` from the inbound
 * `IncomingMessage` before invoking the verifier — see
 * `packages/adapter-node/src/server.ts:89-92`. So the verifier here
 * takes `Request`, matching the Cloudflare side; there is no Node-
 * specific `IncomingMessage` branch.
 */
const sharedSecretVerifier = (secret: string): Verifier => {
  return async (req: Request) => {
    const auth = req.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${secret}`) return null;
    return { tenantPrefix: TENANT, identity: { kind: "shared-secret" } };
  };
};

const listener = createListener({
  app: APP,
  storage,
  verifier: sharedSecretVerifier(sharedSecret),
});

const server = createServer(listener);
server.listen(PORT, () => {
  // Single-line readiness log; container orchestrators key off it
  // for "ready" detection in the gate run. No prom/otel here — Phase
  // 8 wires the production observability story.
  console.log(`baerly-gate-node listening on :${PORT}`);
});

// Graceful shutdown — not production-ready, but enough that the
// gate's `docker stop` doesn't drop in-flight long-polls.
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
