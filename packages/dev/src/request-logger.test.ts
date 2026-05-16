import { createServer } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withRequestLogging } from "./request-logger.ts";

// ANSI CSI prefix: ESC (0x1b) followed by "[".
// Constructed at runtime to avoid embedding a literal control character.
const ESC_BRACKET = String.fromCodePoint(0x1b) + "[";
const hasAnsi = (s: string) => s.includes(ESC_BRACKET);

const startServer = (
  handler: Parameters<typeof withRequestLogging>[0],
  opts?: Parameters<typeof withRequestLogging>[1],
) => {
  const wrapped = withRequestLogging(handler, opts);
  const server = createServer(wrapped);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const close = () =>
        new Promise<void>((res, rej) => {
          server.close((err) => {
            if (err) {
              rej(err);
            } else {
              res();
            }
          });
        });
      resolve({ url: `http://127.0.0.1:${addr.port}`, close });
    });
  });
};

describe("withRequestLogging", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  test("POST /v1/x emits one line with status and duration", async () => {
    const collected: string[] = [];
    const { url, close: c } = await startServer(
      (_req, res) => {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end("{}");
      },
      { write: (chunk) => collected.push(chunk), plain: true },
    );
    close = c;

    await fetch(`${url}/v1/x`, { method: "POST", body: "{}" });
    await vi.waitFor(() => expect(collected).toHaveLength(1));

    const line = collected[0]!;
    expect(line).toContain("POST");
    expect(line).toContain("/v1/x");
    expect(line).toContain("201");
    expect(line).toMatch(/\d+ms/);
  });

  test("TTY mode emits ANSI color escapes for POST", async () => {
    const collected: string[] = [];
    const { url, close: c } = await startServer(
      (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      { write: (chunk) => collected.push(chunk), plain: false },
    );
    close = c;

    await fetch(`${url}/v1/x`, { method: "POST" });
    await vi.waitFor(() => expect(collected).toHaveLength(1));

    expect(hasAnsi(collected[0]!)).toBe(true);
  });

  test("GET /v1/since/... matches default ignore — no line emitted", async () => {
    const collected: string[] = [];
    const { url, close: c } = await startServer(
      (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      { write: (chunk) => collected.push(chunk), plain: true },
    );
    close = c;

    const response = await fetch(`${url}/v1/since/abc123`);
    await response.text();

    expect(collected).toHaveLength(0);
  });

  test("custom ignore:[] overrides default — /v1/since/... IS logged", async () => {
    const collected: string[] = [];
    const { url, close: c } = await startServer(
      (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      { write: (chunk) => collected.push(chunk), plain: true, ignore: [] },
    );
    close = c;

    await fetch(`${url}/v1/since/abc123`);
    await vi.waitFor(() => expect(collected).toHaveLength(1));

    expect(collected[0]).toContain("/v1/since/abc123");
  });

  test("quiet:true — zero emissions for any request", async () => {
    const collected: string[] = [];
    const { url, close: c } = await startServer(
      (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      { write: (chunk) => collected.push(chunk), plain: true, quiet: true },
    );
    close = c;

    await (await fetch(`${url}/v1/x`)).text();
    await (await fetch(`${url}/v1/y`, { method: "POST" })).text();

    expect(collected).toHaveLength(0);
  });

  test("socket destroy emits exactly one line — single-shot guard holds", async () => {
    const collected: string[] = [];
    const { url, close: c } = await startServer(
      (_req, res) => {
        res.writeHead(200);
        res.socket?.destroy();
      },
      { write: (chunk) => collected.push(chunk), plain: true },
    );
    close = c;

    try {
      await fetch(`${url}/v1/destroy`);
    } catch {
      // Expected — socket was destroyed
    }
    await vi.waitFor(() => expect(collected).toHaveLength(1));
  });

  test("multiple sequential requests — one line each", async () => {
    const collected: string[] = [];
    const { url, close: c } = await startServer(
      (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      { write: (chunk) => collected.push(chunk), plain: true },
    );
    close = c;

    await fetch(`${url}/v1/a`);
    await fetch(`${url}/v1/b`, { method: "POST" });
    await fetch(`${url}/v1/c`);
    await vi.waitFor(() => expect(collected).toHaveLength(3));

    expect(collected[0]).toContain("/v1/a");
    expect(collected[1]).toContain("POST");
    expect(collected[2]).toContain("/v1/c");
  });
});
