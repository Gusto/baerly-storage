/**
 * `cloudflare-pool` global setup: runs the S3 wire echo server
 * (`tests/fixtures/s3-wire-echo-server.ts`) on the host for the run and
 * provides its origin, so a Workerd test can PUT over a real socket and
 * read back how the request was framed.
 */
import type { TestProject } from "vitest/node";
import { startS3WireEchoServer } from "../fixtures/s3-wire-echo-server.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** Origin (`http://127.0.0.1:<port>`) of the S3 wire echo server. */
    s3WireEchoOrigin: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await startS3WireEchoServer();
  project.provide("s3WireEchoOrigin", server.origin);
  return server.close;
}
