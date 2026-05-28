import { describe, expect, test } from "vitest";
import { refreshingSigner } from "./signer.ts";
import type { Credentials } from "./types.ts";

describe("refreshingSigner — static credentials", () => {
  test("signs a request with provided static credentials", async () => {
    const sign = refreshingSigner({
      region: "us-east-1",
      credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret123" },
    });
    const req = new Request("https://s3.us-east-1.amazonaws.com/bucket/key", {
      method: "GET",
    });
    const signed = await sign(req);
    expect(signed.headers.get("Authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\//);
  });

  test("includes x-amz-security-token header when sessionToken is provided", async () => {
    const sign = refreshingSigner({
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIATEST",
        secretAccessKey: "secret123",
        sessionToken: "TEMP-SESSION-TOKEN",
      },
    });
    const signed = await sign(new Request("https://s3.us-east-1.amazonaws.com/bucket/key"));
    expect(signed.headers.get("x-amz-security-token")).toBe("TEMP-SESSION-TOKEN");
  });
});

describe("refreshingSigner — provider with expiration", () => {
  test("calls provider once on first sign and reuses across calls before expiration", async () => {
    let calls = 0;
    const provider = async () => {
      calls += 1;
      return {
        accessKeyId: "ASIATEST",
        secretAccessKey: "secret",
        sessionToken: "tok1",
        expiration: new Date(1_000_000 + 3600_000), // 1h from t=1_000_000
      };
    };
    const sign = refreshingSigner({
      region: "us-east-1",
      credentials: provider,
      now: () => 1_000_000,
    });
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    expect(calls).toBe(1);
  });

  test("refreshes when within 5min of expiration", async () => {
    let calls = 0;
    let currentTime = 1_000_000;
    const provider = async () => {
      calls += 1;
      return {
        accessKeyId: `ASIATEST${calls}`,
        secretAccessKey: "secret",
        expiration: new Date(currentTime + 3600_000),
      };
    };
    const sign = refreshingSigner({
      region: "us-east-1",
      credentials: provider,
      now: () => currentTime,
    });
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    expect(calls).toBe(1);
    // jump to 4 min before original expiration — within 5-min buffer
    currentTime = 1_000_000 + 3600_000 - 4 * 60_000;
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    expect(calls).toBe(2);
  });

  test("provider without expiration is called exactly once (treated as static)", async () => {
    let calls = 0;
    const provider = async () => {
      calls += 1;
      return { accessKeyId: "AKIATEST", secretAccessKey: "secret" };
    };
    const sign = refreshingSigner({
      region: "us-east-1",
      credentials: provider,
      now: () => 1_000_000,
    });
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    expect(calls).toBe(1);
  });
});

describe("refreshingSigner — concurrency", () => {
  test("single-flights concurrent refreshes", async () => {
    let calls = 0;
    const slot: { resolve: ((c: Credentials) => void) | null } = { resolve: null };
    const provider = (): Promise<Credentials> => {
      calls += 1;
      return new Promise<Credentials>((res) => {
        slot.resolve = res;
      });
    };
    const sign = refreshingSigner({
      region: "us-east-1",
      credentials: provider,
      now: () => 1_000_000,
    });
    // Kick off three concurrent sign() calls before the provider resolves
    const p1 = sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    const p2 = sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    const p3 = sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    // Yield to the event loop so any queued microtasks/macrotasks finish
    // before we assert. provider() invocation is synchronous inside the
    // promise executor, so `calls` is already 1 by this point — the yield
    // is defensive in case the resolve() body grows an early await.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    slot.resolve?.({
      accessKeyId: "ASIATEST",
      secretAccessKey: "secret",
      expiration: new Date(1_000_000 + 3600_000),
    });
    await Promise.all([p1, p2, p3]);
    expect(calls).toBe(1);
  });

  test("clears in-flight after provider rejects so the next call retries", async () => {
    let calls = 0;
    const errors: Error[] = [];
    const provider = async (): Promise<Credentials> => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient");
      }
      return { accessKeyId: "AKIATEST", secretAccessKey: "secret" };
    };
    const sign = refreshingSigner({ region: "us-east-1", credentials: provider });
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k")).catch((error) =>
      errors.push(error as Error),
    );
    expect(errors[0]?.message).toBe("transient");
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    expect(calls).toBe(2);
  });
});
