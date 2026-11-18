/**
 * A local `node:http` server that records how each PUT arrived on the
 * wire: its framing (`Content-Length`, `Transfer-Encoding`), the byte
 * count actually received, and the SigV4 headers. An in-process `fetch`
 * stub cannot show framing, which is decided by the HTTP client (undici on
 * Node, workerd's own stack in a Worker).
 *
 * Every PUT answers `200` with an `ETag`, so `S3HttpStorage.put` resolves.
 * `GET /__seen?path=<pathname>` returns the record of the last PUT to that
 * path as JSON, which lets a test running inside Workerd read what the
 * server saw. Node-only: Workerd tests reach it through the
 * `cloudflare-pool` global setup (`tests/setup/s3-wire-echo-server.ts`).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface SeenPut {
  contentLength: string | null;
  transferEncoding: string | null;
  bytes: number;
  authorization: string | null;
  contentSha256: string | null;
}

export interface EchoServer {
  origin: string;
  seen: Map<string, SeenPut>;
  close: () => Promise<void>;
}

export async function startS3WireEchoServer(): Promise<EchoServer> {
  const seen = new Map<string, SeenPut>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/__seen") {
      const record = seen.get(url.searchParams.get("path") ?? "");
      res.writeHead(record === undefined ? 404 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(record ?? null));
      return;
    }
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.on("end", () => {
      if (req.method === "PUT") {
        const header = (name: string): string | null => {
          const value = req.headers[name];
          return typeof value === "string" ? value : null;
        };
        seen.set(url.pathname, {
          contentLength: header("content-length"),
          transferEncoding: header("transfer-encoding"),
          bytes,
          authorization: header("authorization"),
          contentSha256: header("x-amz-content-sha256"),
        });
      }
      res.writeHead(200, { ETag: '"echo"' });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
