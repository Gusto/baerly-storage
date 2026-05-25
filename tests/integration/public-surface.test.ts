/**
 * Published-surface gate: asserts that every subpath declared in the
 * `baerly-storage` `exports` map resolves and exposes representative
 * named exports.
 *
 * Imports use the `baerly-storage` package name exactly as a consumer
 * would after `npm install baerly-storage` — not the internal
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
 * deliberately imports `baerly-storage/node` (Node-only) so it must
 * NOT be added to the cloudflare-pool project.
 */

import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// baerly-storage (root barrel)
// ---------------------------------------------------------------------------
import { BaerlyError, Db, MemoryStorage } from "baerly-storage";

describe("baerly-storage", () => {
  test("imports resolve", () => {
    expect(typeof Db).toBe("function");
    expect(typeof BaerlyError).toBe("function");
    expect(typeof MemoryStorage).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// baerly-storage/auth
// ---------------------------------------------------------------------------
import { bearerJwt, cloudflareAccess, sharedSecret } from "baerly-storage/auth";

describe("baerly-storage/auth", () => {
  test("imports resolve", () => {
    expect(typeof cloudflareAccess).toBe("function");
    expect(typeof sharedSecret).toBe("function");
    expect(typeof bearerJwt).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// baerly-storage/http
// ---------------------------------------------------------------------------
import {
  createRouter,
  listEventsSince,
  longPollSince,
  mapError,
  MAX_BODY_BYTES,
} from "baerly-storage/http";

describe("baerly-storage/http", () => {
  test("imports resolve", () => {
    expect(typeof createRouter).toBe("function");
    expect(typeof listEventsSince).toBe("function");
    expect(typeof longPollSince).toBe("function");
    expect(typeof mapError).toBe("function");
    expect(typeof MAX_BODY_BYTES).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// baerly-storage/maintenance
// ---------------------------------------------------------------------------
import {
  CLOUDFLARE_FREE_TIER,
  compact,
  migrateCollection,
  rebuildIndex,
  runGc,
  runScheduledMaintenance,
} from "baerly-storage/maintenance";

describe("baerly-storage/maintenance", () => {
  test("imports resolve", () => {
    expect(typeof runScheduledMaintenance).toBe("function");
    expect(typeof CLOUDFLARE_FREE_TIER).toBe("object");
    expect(typeof compact).toBe("function");
    expect(typeof runGc).toBe("function");
    expect(typeof rebuildIndex).toBe("function");
    expect(typeof migrateCollection).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// baerly-storage/observability
// ---------------------------------------------------------------------------
import {
  configureObservability,
  createObservabilityContext,
  getLogger,
  withObservability,
} from "baerly-storage/observability";

describe("baerly-storage/observability", () => {
  test("imports resolve", () => {
    expect(typeof configureObservability).toBe("function");
    expect(typeof createObservabilityContext).toBe("function");
    expect(typeof getLogger).toBe("function");
    expect(typeof withObservability).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// baerly-storage/cloudflare
// ---------------------------------------------------------------------------
import { baerlyWorker, r2BindingStorage } from "baerly-storage/cloudflare";

describe("baerly-storage/cloudflare", () => {
  test("imports resolve", () => {
    expect(typeof r2BindingStorage).toBe("function");
    expect(typeof baerlyWorker).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// baerly-storage/node
// ---------------------------------------------------------------------------
import {
  baerlyNode,
  createApp,
  gcsStorage,
  minioStorage,
  r2Storage,
  runMaintenanceTick,
  S3HttpStorage as NodeS3HttpStorage,
  s3Storage,
} from "baerly-storage/node";

describe("baerly-storage/node", () => {
  test("imports resolve", () => {
    expect(typeof baerlyNode).toBe("function");
    expect(typeof createApp).toBe("function");
    expect(typeof s3Storage).toBe("function");
    expect(typeof r2Storage).toBe("function");
    expect(typeof minioStorage).toBe("function");
    expect(typeof gcsStorage).toBe("function");
    expect(typeof NodeS3HttpStorage).toBe("function");
    expect(typeof runMaintenanceTick).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// baerly-storage/client
// ---------------------------------------------------------------------------
import { BaerlyError as ClientBaerlyError, createBaerlyClient } from "baerly-storage/client";

describe("baerly-storage/client", () => {
  test("imports resolve", () => {
    expect(typeof createBaerlyClient).toBe("function");
    expect(typeof ClientBaerlyError).toBe("function");
    expect(ClientBaerlyError).toBe(BaerlyError);
  });
});

// ---------------------------------------------------------------------------
// baerly-storage/client/react
// ---------------------------------------------------------------------------
import {
  BaerlyProvider,
  useBaerlyClient,
  useDelete,
  useInsert,
  useInvalidationTick,
  useLiveDocument,
  useLiveQuery,
  useReplace,
  useUpdate,
} from "baerly-storage/client/react";

describe("baerly-storage/client/react", () => {
  test("imports resolve", () => {
    expect(typeof BaerlyProvider).toBe("function");
    expect(typeof useBaerlyClient).toBe("function");
    expect(typeof useLiveQuery).toBe("function");
    expect(typeof useLiveDocument).toBe("function");
    expect(typeof useInvalidationTick).toBe("function");
    expect(typeof useInsert).toBe("function");
    expect(typeof useUpdate).toBe("function");
    expect(typeof useReplace).toBe("function");
    expect(typeof useDelete).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// baerly-storage/client/testing
// ---------------------------------------------------------------------------
import { MockFetch } from "baerly-storage/client/testing";

describe("baerly-storage/client/testing", () => {
  test("imports resolve", () => {
    expect(typeof MockFetch).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// baerly-storage/dev
// ---------------------------------------------------------------------------
import { ensureTable, LocalFsStorage, printDevBanner, renderDevLanding } from "baerly-storage/dev";

describe("baerly-storage/dev", () => {
  test("imports resolve", () => {
    expect(typeof LocalFsStorage).toBe("function");
    expect(typeof ensureTable).toBe("function");
    expect(typeof printDevBanner).toBe("function");
    expect(typeof renderDevLanding).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// baerly-storage/dev/vite
// ---------------------------------------------------------------------------
import { baerlyDev as baerlyDevVite } from "baerly-storage/dev/vite";

describe("baerly-storage/dev/vite", () => {
  test("imports resolve", () => {
    expect(typeof baerlyDevVite).toBe("function");
  });
});
