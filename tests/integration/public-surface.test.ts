/**
 * Published-surface gate: asserts that every subpath declared in the
 * `@gusto/baerly-storage` `exports` map resolves and exposes representative
 * named exports.
 *
 * Imports use the `@gusto/baerly-storage` package name exactly as a consumer
 * would after `npm install @gusto/baerly-storage` — not the internal
 * `@baerly/*` workspace names. This is the gate that catches missing
 * re-exports, wrong subpath names, and broken `exports` map entries
 * introduced between T2+T3's bundle wiring and the T6 examples /
 * T8 doc sweep.
 *
 * All assertions are `expect(typeof X).toBe("function")` or
 * `"object"` — just enough to prove the symbol reached the caller.
 * The suites that follow test behaviour in depth; this file only
 * tests reachability.
 *
 * Runs in the default vitest project (Node, no Workerd). The file
 * deliberately imports `@gusto/baerly-storage/node` (Node-only) so it must
 * NOT be added to the cloudflare-pool project.
 */

import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// @gusto/baerly-storage (root barrel)
// ---------------------------------------------------------------------------
import { BaerlyError, Db, MemoryStorage } from "@gusto/baerly-storage";

describe("@gusto/baerly-storage", () => {
  test("imports resolve", () => {
    expect(typeof Db).toBe("function");
    expect(typeof BaerlyError).toBe("function");
    expect(typeof MemoryStorage).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// @gusto/baerly-storage/auth
// ---------------------------------------------------------------------------
import { bearerJwt, cloudflareAccess, sharedSecret } from "@gusto/baerly-storage/auth";

describe("@gusto/baerly-storage/auth", () => {
  test("imports resolve", () => {
    expect(typeof cloudflareAccess).toBe("function");
    expect(typeof sharedSecret).toBe("function");
    expect(typeof bearerJwt).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// @gusto/baerly-storage/http
// ---------------------------------------------------------------------------
import {
  createRouter,
  listEventsSince,
  longPollSince,
  mapError,
  MAX_BODY_BYTES,
} from "@gusto/baerly-storage/http";

describe("@gusto/baerly-storage/http", () => {
  test("imports resolve", () => {
    expect(typeof createRouter).toBe("function");
    expect(typeof listEventsSince).toBe("function");
    expect(typeof longPollSince).toBe("function");
    expect(typeof mapError).toBe("function");
    expect(typeof MAX_BODY_BYTES).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// @gusto/baerly-storage/maintenance
// ---------------------------------------------------------------------------
import {
  CLOUDFLARE_FREE_TIER,
  compact,
  rebuildIndex,
  runGc,
  runScheduledMaintenance,
} from "@gusto/baerly-storage/maintenance";

describe("@gusto/baerly-storage/maintenance", () => {
  test("imports resolve", () => {
    expect(typeof runScheduledMaintenance).toBe("function");
    expect(typeof CLOUDFLARE_FREE_TIER).toBe("object");
    expect(typeof compact).toBe("function");
    expect(typeof runGc).toBe("function");
    expect(typeof rebuildIndex).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// @gusto/baerly-storage/observability
// ---------------------------------------------------------------------------
import {
  configureObservability,
  createObservabilityContext,
  getLogger,
  withHttpObservability,
} from "@gusto/baerly-storage/observability";

describe("@gusto/baerly-storage/observability", () => {
  test("imports resolve", () => {
    expect(typeof configureObservability).toBe("function");
    expect(typeof createObservabilityContext).toBe("function");
    expect(typeof getLogger).toBe("function");
    expect(typeof withHttpObservability).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// @gusto/baerly-storage/cloudflare
// ---------------------------------------------------------------------------
import { baerlyWorker, r2BindingStorage } from "@gusto/baerly-storage/cloudflare";

describe("@gusto/baerly-storage/cloudflare", () => {
  test("imports resolve", () => {
    expect(typeof r2BindingStorage).toBe("function");
    expect(typeof baerlyWorker).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// @gusto/baerly-storage/node
// ---------------------------------------------------------------------------
import {
  baerlyNode,
  gcsStorage,
  minioStorage,
  r2Storage,
  S3HttpStorage as NodeS3HttpStorage,
  s3Storage,
} from "@gusto/baerly-storage/node";

describe("@gusto/baerly-storage/node", () => {
  test("imports resolve", () => {
    expect(typeof baerlyNode).toBe("function");
    expect(typeof s3Storage).toBe("function");
    expect(typeof r2Storage).toBe("function");
    expect(typeof minioStorage).toBe("function");
    expect(typeof gcsStorage).toBe("function");
    expect(typeof NodeS3HttpStorage).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// @gusto/baerly-storage/client
// ---------------------------------------------------------------------------
import { BaerlyError as ClientBaerlyError, createBaerlyClient } from "@gusto/baerly-storage/client";

describe("@gusto/baerly-storage/client", () => {
  test("imports resolve", () => {
    expect(typeof createBaerlyClient).toBe("function");
    expect(typeof ClientBaerlyError).toBe("function");
    expect(ClientBaerlyError).toBe(BaerlyError);
  });
});

// ---------------------------------------------------------------------------
// @gusto/baerly-storage/client/react
// ---------------------------------------------------------------------------
import { createBaerlyReact } from "@gusto/baerly-storage/client/react";

describe("@gusto/baerly-storage/client/react", () => {
  test("createBaerlyReact resolves and yields the bound hook set", () => {
    expect(typeof createBaerlyReact).toBe("function");
    const { BaerlyProvider, useBaerlyClient, useMutation, useQuery } = createBaerlyReact();
    expect(typeof BaerlyProvider).toBe("function");
    expect(typeof useBaerlyClient).toBe("function");
    expect(typeof useQuery).toBe("function");
    expect(typeof useMutation).toBe("function");
    expect(typeof useQuery.skip).toBe("symbol");
  });
});

// ---------------------------------------------------------------------------
// @gusto/baerly-storage/dev
// ---------------------------------------------------------------------------
import {
  ensureTable,
  LocalFsStorage,
  printDevBanner,
  renderDevLanding,
} from "@gusto/baerly-storage/dev";

describe("@gusto/baerly-storage/dev", () => {
  test("imports resolve", () => {
    expect(typeof LocalFsStorage).toBe("function");
    expect(typeof ensureTable).toBe("function");
    expect(typeof printDevBanner).toBe("function");
    expect(typeof renderDevLanding).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// @gusto/baerly-storage/dev/vite
// ---------------------------------------------------------------------------
import { baerlyDev as baerlyDevVite } from "@gusto/baerly-storage/dev/vite";

describe("@gusto/baerly-storage/dev/vite", () => {
  test("imports resolve", () => {
    expect(typeof baerlyDevVite).toBe("function");
  });
});
