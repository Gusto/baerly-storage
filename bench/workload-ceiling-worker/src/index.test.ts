import { describe, expect, test, vi } from "vitest";
import type { Storage } from "@baerly/protocol";
import worker, { type WorkloadCeilingWorkerEnv } from "./index.ts";

vi.mock("@baerly/adapter-cloudflare", () => ({
  // eslint-disable-next-line vitest/require-mock-type-parameters
  r2BindingStorage: vi.fn(),
}));

const { r2BindingStorage } = await import("@baerly/adapter-cloudflare");
const mockR2BindingStorage = vi.mocked(r2BindingStorage);

// The env cast is safe on every path under test: the 401 guard returns
// before `env.BUCKET` is ever read, and the 400 path (decode failure)
// returns before it too — no real R2 binding is needed.
const env = (sharedSecret: string | undefined): WorkloadCeilingWorkerEnv =>
  ({ WORKLOAD_CEILING_SHARED_SECRET: sharedSecret }) as unknown as WorkloadCeilingWorkerEnv;

// Node's `Request` normalizes trailing HTTP whitespace off header values, so
// a literal `Authorization: Bearer ` (empty token) cannot be constructed
// through the real constructor — it collapses to `Bearer` (token `null`).
// The fail-open bug under test is specifically the RAW empty-token header
// reaching `constantTimeEqual("", <unset secret>)` as equal-empty-bytes, so
// these requests carry a hand-rolled headers view that preserves the exact
// bytes. Everything else the handler touches (`method`, `url`, `text`) is a
// plain value on the duck-typed object.
const postRun = (authorization: string, body = "not-json"): Request =>
  ({
    method: "POST",
    url: "https://study.example/run",
    headers: {
      get: (name: string): string | null => (name === "authorization" ? authorization : null),
    },
    text: () => Promise.resolve(body),
  }) as unknown as Request;

// Simple mock storage implementation
function createMockStorage(files: Record<string, string>): Storage {
  const get = async (
    key: string,
    _options?: { signal?: AbortSignal },
  ): Promise<{ body: Uint8Array; metadata?: Record<string, string> } | null> => {
    const content = files[key];
    if (content === undefined) {
      return null;
    }
    return {
      body: new TextEncoder().encode(content),
      metadata: undefined,
    };
  };

  return {
    get,
    // vitest-ignore: mock storage implementation, type parameters not required
    // eslint-disable-next-line vitest/require-mock-type-parameters
    delete: vi.fn(),
    // eslint-disable-next-line vitest/require-mock-type-parameters
    deleteMany: vi.fn(),
    // eslint-disable-next-line vitest/require-mock-type-parameters
    put: vi.fn(),
    // eslint-disable-next-line vitest/require-mock-type-parameters
    list: vi.fn(),
    // eslint-disable-next-line vitest/require-mock-type-parameters
    close: vi.fn(),
  } as unknown as Storage;
}

const fixturePrefix = "test-fixture";
const validRequest = {
  contract_id: "baerly.workload-ceiling/chunked-snapshot/v1" as const,
  run_id: "test-run-id",
  scenario_id: "test-scenario",
  implementation: "monolithic-control" as const,
  fixture_prefix: fixturePrefix,
};

// Import encoding functions for proper canonical JSON
import { encodeWorkloadCeilingRunRequest } from "../../measurement/workload-ceiling-harness.ts";

describe("POST /run authentication fails closed", () => {
  test("a missing secret rejects an empty bearer token", async () => {
    // The operator forgot `wrangler secret put`: the binding is absent, and
    // `constantTimeEqual("", undefined)` compares zero bytes to zero bytes —
    // equal. The handler must reject before that compare is reached.
    const response = await worker.fetch(postRun("Bearer "), env(undefined));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  test("a missing secret rejects a real-looking token", async () => {
    const response = await worker.fetch(postRun("Bearer real-looking-token"), env(undefined));
    expect(response.status).toBe(401);
  });

  test("a blank secret rejects even a matching blank token", async () => {
    const response = await worker.fetch(postRun("Bearer  "), env("  "));
    expect(response.status).toBe(401);
  });

  test("a set secret with the correct token still reaches request decoding", async () => {
    // Pins that the fail-closed guard did not overfire: correct secret +
    // token gets PAST auth and dies on the garbage body with 400, not 401.
    const response = await worker.fetch(
      postRun("Bearer real-secret", "garbage"),
      env("real-secret"),
    );
    expect(response.status).toBe(400);
  });
});

describe("Wrong method/path returns 404", () => {
  test("returns 404 for GET request", async () => {
    const request = {
      method: "GET",
      url: "https://example.com/run",
      headers: {
        get: (name: string): string | null => (name === "authorization" ? "Bearer token" : null),
      },
    } as unknown as Request;
    const response = await worker.fetch(request, env("secret"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "not found: POST /run only",
    });
  });

  test("returns 404 for wrong path", async () => {
    const request = {
      method: "POST",
      url: "https://example.com/other",
      headers: {
        get: (name: string): string | null => (name === "authorization" ? "Bearer token" : null),
      },
    } as unknown as Request;
    const response = await worker.fetch(request, env("secret"));
    expect(response.status).toBe(404);
  });
});

describe("Success path with mocked storage", () => {
  test("succeeds on monolithic-control implementation", async () => {
    const mockStorage = createMockStorage({
      [`${fixturePrefix}/fixture.json`]: JSON.stringify({
        contract_id: "baerly.workload-ceiling/chunked-snapshot/v1",
        collection: "test-collection",
        monolithic_key: `${fixturePrefix}/monolithic.json`,
        manifest_key: `${fixturePrefix}/manifest.json`,
        log_seq_start: 0,
      }),
      [`${fixturePrefix}/monolithic.json`]: JSON.stringify({
        rows: [{ _id: "doc1" as const, body: { _id: "doc1" as const, data: "value" } }],
      }),
    });

    mockR2BindingStorage.mockReturnValue(mockStorage);

    const body = encodeWorkloadCeilingRunRequest(validRequest);
    const request = {
      method: "POST",
      url: "https://example.com/run",
      headers: {
        get: (name: string): string | null => (name === "authorization" ? "Bearer secret" : null),
      },
      text: () => Promise.resolve(body),
    } as unknown as Request;

    const response = await worker.fetch(request, env("secret"));
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      row_count: number;
      contract_id: string;
      run_id: string;
      scenario_id: string;
      implementation: string;
    };
    expect(result.row_count).toBe(1);
    expect(result.contract_id).toBe("baerly.workload-ceiling/chunked-snapshot/v1");
    expect(result.run_id).toBe("test-run-id");
    expect(result.scenario_id).toBe("test-scenario");
    expect(result.implementation).toBe("monolithic-control");
  });
});
