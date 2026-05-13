import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createListener } from "@baerly/adapter-node";
import { LocalFsStorage } from "@baerly/dev";
import { BaerlyError, CURRENT_JSON_SCHEMA_VERSION, createCurrentJson } from "@baerly/protocol";
import type { Verifier } from "@baerly/protocol";

const PORT = Number(process.env.PORT ?? 3000);
const SHARED_SECRET = process.env.HELPDESK_SECRET ?? "dev-helpdesk-secret";
const TENANT = "helpdesk-demo";
const APP = "helpdesk";
const UI_URL = process.env.HELPDESK_UI_URL ?? "http://localhost:5173";

// Local-fs storage rooted at examples/helpdesk/.baerly-data/.
// gitignored; deleted on reset (`rm -rf .baerly-data && pnpm dev`).
const HERE = dirname(fileURLToPath(import.meta.url));
const STORAGE_ROOT = resolve(HERE, "..", "..", "..", ".baerly-data");
await mkdir(STORAGE_ROOT, { recursive: true });
const storage = new LocalFsStorage({ root: STORAGE_ROOT });

// One-time current.json seed for the `tickets` table. The first
// `client.table("tickets").insert(...)` from the seed script /
// web app would otherwise fail because no CAS pointer exists yet.
// Idempotent — second call throws BaerlyError{code:"Conflict"};
// we swallow it.
try {
  await createCurrentJson(storage, `app/${APP}/tenant/${TENANT}/manifests/tickets/current.json`, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    writer_fence: {
      epoch: 0,
      owner: "helpdesk-bootstrap",
      claimed_at: new Date().toISOString(),
    },
  });
} catch (e) {
  if (!(e instanceof BaerlyError) || e.code !== "Conflict") throw e;
}

// Day-1 inline sharedSecret Verifier. ~10 lines. Phase 8 ships
// `sharedSecret({ secret })` from `@baerly/auth` (ticket 37); swap
// to that one-line factory when 37 lands.
const verifier: Verifier = async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${SHARED_SECRET}`) return null;
  return { tenantPrefix: TENANT, identity: { kind: "shared-secret" } };
};

// `observability: {}` lets `createListener` auto-pick the
// `console-pretty` LogTape sink on a TTY (production hosts piping
// stdout get the JSON sink). One human-readable line per request
// lands in the dev terminal so user actions are visible.
// `dev:` mounts a small HTML landing page on `GET /` so a curious
// user clicking the :3000 link sees an explanation instead of the
// JSON 404 envelope.
const listener = createListener({
  app: APP,
  storage,
  verifier,
  observability: {},
  dev: { app: APP, uiUrl: UI_URL, appLabel: "Helpdesk demo" },
});
createServer(listener).listen(PORT, () => {
  console.log(`helpdesk api → http://localhost:${PORT}  (open the UI at ${UI_URL})`);
});
