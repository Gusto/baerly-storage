/**
 * S3 answers an expired STS session token with HTTP 400 and
 * `<Code>ExpiredToken</Code>` (or `TokenRefreshRequired`), not 403.
 * `S3HttpStorage` + `refreshingSigner` drop the cached credentials and
 * resend once; a second rejection is `AccessDenied` naming the S3 code.
 */

import { BaerlyError, RequestLedger } from "@baerly/protocol";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import { describe, expect, test } from "vitest";
import { refreshingSigner } from "./credentials/signer.ts";
import type { Credentials } from "./credentials/types.ts";
import { S3HttpStorage, type S3HttpStorageOptions, withCredentialInvalidation } from "./s3-http.ts";

const s3Error = (code: string, message = "boom"): Response =>
  new Response(
    `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    {
      status: 400,
    },
  );

const ok = (): Response => new Response("v", { status: 200, headers: { ETag: '"e"' } });

/** Which key (`ASIA<n>`) signed the request. */
const signedWith = (req: Request): string =>
  /Credential=(ASIA\d+)\//.exec(req.headers.get("Authorization") ?? "")?.[1] ?? "unsigned";

/** A provider whose n-th result carries key `ASIA<n>` and (by default) a far-future expiry. */
const mkProvider = (expiration?: Date) => {
  const state = { calls: 0 };
  const provider = async (): Promise<Credentials> => {
    state.calls += 1;
    return {
      accessKeyId: `ASIA${state.calls}`,
      secretAccessKey: "secret",
      sessionToken: "tok",
      ...(expiration !== undefined && { expiration }),
    };
  };
  return { provider, state };
};

const mkStorage = (
  fetchImpl: (req: Request) => Response | Promise<Response>,
  provider: () => Promise<Credentials>,
  retries = 2,
) => {
  const sign = refreshingSigner({ region: "us-east-1", credentials: provider });
  const seen: Request[] = [];
  const base = new S3HttpStorage({
    endpoint: "https://example.invalid",
    bucket: "b",
    sign,
    fetch: (async (input: RequestInfo | URL) => {
      const req = input as Request;
      seen.push(req);
      return fetchImpl(req);
    }) as typeof fetch,
    retries,
    backoffMs: 0,
  });
  const storage =
    sign.invalidate === undefined ? base : withCredentialInvalidation(base, sign.invalidate);
  return { storage, seen };
};

describe("S3 expired session token", () => {
  test.each(["ExpiredToken", "TokenRefreshRequired"])(
    "%s then success: one refresh, one resend, resolves",
    async (code) => {
      const { provider, state } = mkProvider();
      const { storage, seen } = mkStorage(
        (req) => (signedWith(req) === "ASIA1" ? s3Error(code) : ok()),
        provider,
      );
      const got = await storage.get("k");
      expect(got?.etag).toBe('"e"');
      expect(state.calls).toBe(2);
      expect(seen.map(signedWith)).toEqual(["ASIA1", "ASIA2"]);
    },
  );

  test("a PUT body survives the resend", async () => {
    const { provider } = mkProvider();
    const bodies: string[] = [];
    const { storage } = mkStorage(async (req) => {
      bodies.push(await req.text());
      return signedWith(req) === "ASIA1" ? s3Error("ExpiredToken") : ok();
    }, provider);
    await storage.put("k", new TextEncoder().encode("payload"));
    expect(bodies).toEqual(["payload", "payload"]);
  });

  test.each(["ExpiredToken", "TokenRefreshRequired"])(
    "%s twice: AccessDenied naming the S3 code, one resend only (retries do not compound)",
    async (code) => {
      const { provider, state } = mkProvider();
      const { storage, seen } = mkStorage(
        () => s3Error(code, "The provided token has expired."),
        provider,
        2,
      );
      const err = await storage.get("k").catch((error: unknown) => error);
      expect(err).toBeInstanceOf(BaerlyError);
      expect((err as BaerlyError).code).toBe("AccessDenied");
      expect((err as BaerlyError).message).toContain(code);
      expect(seen).toHaveLength(2);
      expect(state.calls).toBe(2);
    },
  );

  test("the resend is the call's only refresh even when a later attempt expires again", async () => {
    // attempt 1: expired -> refresh -> 503; attempt 2 (outer retry): expired again.
    const { provider, state } = mkProvider();
    let n = 0;
    const { storage, seen } = mkStorage(() => {
      n += 1;
      return n === 2 ? new Response("", { status: 503 }) : s3Error("ExpiredToken");
    }, provider);
    const err = await storage.get("k").catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("AccessDenied");
    expect(seen).toHaveLength(3);
    expect(state.calls).toBe(2);
  });

  test("an unrelated 400 maps as before and reads its body once", async () => {
    const { provider, state } = mkProvider();
    const { storage, seen } = mkStorage(() => s3Error("InvalidArgument", "bad arg"), provider);
    const err = await storage.get("k").catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    expect((err as BaerlyError).message).toBe("GET k: 400 InvalidArgument: bad arg");
    expect(seen).toHaveLength(1);
    expect(state.calls).toBe(1);
  });

  test("a 400 with a non-XML body maps as before", async () => {
    const { provider } = mkProvider();
    const { storage } = mkStorage(() => new Response("nope", { status: 400 }), provider);
    const err = await storage.get("k").catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    expect((err as BaerlyError).message).toBe("GET k: 400 nope");
  });

  test("concurrent requests that all see the expired token share one refresh", async () => {
    const { provider, state } = mkProvider();
    const { storage, seen } = mkStorage(
      (req) => (signedWith(req) === "ASIA1" ? s3Error("ExpiredToken") : ok()),
      provider,
    );
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => storage.get(`k${i}`)));
    expect(results.every((r) => r?.etag === '"e"')).toBe(true);
    expect(state.calls).toBe(2);
    expect(seen).toHaveLength(16);
  });

  test("the credential-invalidation hook is not part of the public options", () => {
    const options: S3HttpStorageOptions = {
      endpoint: "e",
      bucket: "b",
      // @ts-expect-error — internal wiring only (`withCredentialInvalidation`).
      invalidateCredentials() {},
    };
    expect(options).toBeDefined();
  });

  test("credentials with no refresh path (static) surface AccessDenied without a resend", async () => {
    const seen: Request[] = [];
    const storage = new S3HttpStorage({
      endpoint: "https://example.invalid",
      bucket: "b",
      fetch: (async (input: RequestInfo | URL) => {
        seen.push(input as Request);
        return s3Error("ExpiredToken");
      }) as typeof fetch,
      retries: 2,
      backoffMs: 0,
    });
    const err = await storage.get("k").catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("AccessDenied");
    expect((err as BaerlyError).message).toContain("ExpiredToken");
    expect(seen).toHaveLength(1);
  });

  test("the resend is charged to the request ledger", async () => {
    const { provider } = mkProvider();
    const { storage } = mkStorage(
      (req) => (signedWith(req) === "ASIA1" ? s3Error("ExpiredToken") : ok()),
      provider,
    );
    const ledger = new RequestLedger({ internal: 100, external: 100 });
    await runWithContext(createObservabilityContext({ ledger }), () => storage.get("k"));
    expect(ledger.charged.external).toBe(2);
  });

  test("a resend the ledger refuses is never sent", async () => {
    const { provider } = mkProvider();
    const { storage, seen } = mkStorage(() => s3Error("ExpiredToken"), provider);
    const ledger = new RequestLedger({ internal: 100, external: 1 });
    const err = await Promise.resolve(
      runWithContext(createObservabilityContext({ ledger }), () => storage.get("k")),
    ).catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("CapacityExceeded");
    expect(seen).toHaveLength(1);
  });
});
