import { createServer } from "node:http";
import { DOMParser } from "@xmldom/xmldom";
import { AwsClient } from "aws4fetch";
import { createListener, S3HttpStorage } from "@baerly/adapter-node";
import { bearerJwt, sharedSecret } from "@baerly/server";
import type { Verifier } from "@baerly/protocol";

const reqEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`Missing required env var: ${name}`);
  return v;
};

const APP = "{{appName}}";
const TENANT = process.env.TENANT ?? "{{tenant}}";
const PORT = Number(process.env.PORT ?? "8080");

const storage = new S3HttpStorage({
  endpoint:
    process.env.S3_ENDPOINT ?? `https://s3.${process.env.AWS_REGION ?? "us-east-1"}.amazonaws.com`,
  bucket: reqEnv("BUCKET"),
  xmlParser: new DOMParser(),
  sign: (req) =>
    new AwsClient({
      accessKeyId: reqEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: reqEnv("AWS_SECRET_ACCESS_KEY"),
      region: process.env.AWS_REGION ?? "us-east-1",
      service: "s3",
    }).sign(req),
});

// Default: JWKS-backed JWT verifier when `JWKS_URL` is set; else
// fall back to the shared-secret verifier for parity with `pnpm dev`.
// Production setups should *always* set `JWKS_URL` and remove the
// shared-secret fallback. See ticket 40's deploy template.
const verifier: Verifier =
  process.env.JWKS_URL !== undefined
    ? bearerJwt({
        jwks: process.env.JWKS_URL,
        issuer: reqEnv("JWT_ISSUER"),
        audience: reqEnv("JWT_AUDIENCE"),
      })
    : sharedSecret({ secret: reqEnv("SHARED_SECRET"), tenantPrefix: TENANT });

const listener = createListener({ app: APP, storage, verifier });
const server = createServer(listener);
server.listen(PORT, () => console.log(`{{appName}} listening on :${PORT}`));
