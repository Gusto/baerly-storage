// Upload fixtures to the deployed bench Worker and drive its arms, one
// request in flight at a time.
//   BENCH_URL=https://<worker>.workers.dev BENCH_SECRET_FILE=<file> \
//     pnpm bench:paid-memory:drive <command> [args]
// Commands:
//   upload <tenant...>          snapshot (or a Worker-side copy) + current.json + tail
//   read <tenant> <n>           point reads of the cell's doc
//   update <tenant> <n>         single-document updates of the same doc
//   fold <tenant> <n>           FORCED fold arm: update, wait for the tick to
//                               fold or time out, then restore the fixture
//   wipe                        delete every bench object (teardown)
// Each request appends one JSON line to $OUT (default out/drive.jsonl):
// the request tag, HTTP status, client wall time, and the body when not 2xx.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CellManifest, COLLECTION, currentJsonKey } from "./cells.ts";

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env["BENCH_URL"];
const secretFile = process.env["BENCH_SECRET_FILE"];
if (base === undefined || secretFile === undefined) {
  throw new Error("set BENCH_URL and BENCH_SECRET_FILE");
}
const secret = readFileSync(secretFile, "utf8").trim();
const out = process.env["OUT"] ?? join(here, "out", "drive.jsonl");
mkdirSync(dirname(out), { recursive: true });
const manifests = JSON.parse(
  readFileSync(join(here, "out", "manifest.json"), "utf8"),
) as CellManifest[];
const cell = (tenant: string): CellManifest => {
  const m = manifests.find((c) => c.tenant === tenant);
  if (m === undefined) {
    throw new Error(`no manifest for ${tenant}`);
  }
  return m;
};
const fixtureFile = (rel: string): string => join(here, "out", "fixtures", rel);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const call = async (
  method: string,
  path: string,
  opts: { tenant?: string; body?: BodyInit; json?: unknown } = {},
): Promise<{ status: number; text: string; ms: number }> => {
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  if (opts.tenant !== undefined) {
    headers["x-bench-tenant"] = opts.tenant;
  }
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const t0 = performance.now();
  const res = await fetch(new URL(path, base), {
    method,
    headers,
    ...(body !== undefined && { body }),
    signal: AbortSignal.timeout(600_000),
  });
  const text = await res.text();
  return { status: res.status, text, ms: performance.now() - t0 };
};

const benchJson = async <T>(method: string, path: string, json?: unknown): Promise<T> => {
  const r = await call(method, path, json === undefined ? {} : { json });
  if (r.status !== 200) {
    throw new Error(`${method} ${path}: ${r.status} ${r.text.slice(0, 500)}`);
  }
  return JSON.parse(r.text) as T;
};

const record = (line: Record<string, unknown>): void => {
  appendFileSync(out, `${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`);
  console.log(JSON.stringify(line));
};

/** One measured `/v1` request; the tag rides in `?bench=` so tail events join to it. */
const measured = async (
  m: CellManifest,
  arm: string,
  i: number,
  method: "GET" | "PATCH",
): Promise<{ status: number }> => {
  const tag = `${m.tenant}.${arm}.${i}`;
  const path = `/v1/c/${COLLECTION}/${m.docId}?bench=${encodeURIComponent(tag)}`;
  const r = await call(
    method,
    path,
    method === "PATCH" ? { tenant: m.tenant, json: { patch: { n: i + 1 } } } : { tenant: m.tenant },
  );
  const ok = r.status >= 200 && r.status < 300;
  record({
    tenant: m.tenant,
    arm,
    i,
    tag,
    status: r.status,
    wallMs: Math.round(r.ms),
    ...(!ok && { body: r.text.slice(0, 2000) }),
  });
  return { status: r.status };
};

interface Head {
  readonly current: {
    readonly snapshot: string;
    readonly log_seq_start: number;
    readonly tail_hint: number;
    readonly snapshot_bytes: number;
    readonly snapshot_rows: number;
    readonly mean_entry_bytes?: number;
  } | null;
}
const head = (tenant: string) => benchJson<Head>("GET", `/bench/head?tenant=${tenant}`);

const upload = async (m: CellManifest): Promise<void> => {
  if (m.snapshotCopyFrom === undefined) {
    const body = readFileSync(fixtureFile(m.snapshotFile));
    const raw = await call("PUT", `/bench/object?key=${encodeURIComponent(m.snapshotKey)}`, {
      body,
    });
    if (raw.status !== 200) {
      throw new Error(`snapshot upload ${m.tenant}: ${raw.status} ${raw.text.slice(0, 500)}`);
    }
    const r = JSON.parse(raw.text) as { size: number };
    if (r.size !== m.snapshotBytes) {
      throw new Error(`${m.tenant}: snapshot size ${r.size} != ${m.snapshotBytes}`);
    }
  } else {
    const from = cell(m.snapshotCopyFrom).snapshotKey;
    const r = await benchJson<{ size: number }>(
      "POST",
      `/bench/copy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(m.snapshotKey)}`,
    );
    if (r.size !== m.snapshotBytes) {
      throw new Error(`${m.tenant}: copied snapshot size ${r.size} != ${m.snapshotBytes}`);
    }
  }
  const small = JSON.parse(readFileSync(fixtureFile(m.smallFile), "utf8")) as Record<
    string,
    string
  >;
  // current.json goes last, so a partial upload never points at a missing entry.
  const cur = currentJsonKey(m.tenant);
  const keys = Object.keys(small).filter((k) => k !== cur);
  let batch: Record<string, string> = {};
  let bytes = 0;
  const flush = async () => {
    if (Object.keys(batch).length > 0) {
      await benchJson("POST", "/bench/objects", batch);
    }
    batch = {};
    bytes = 0;
  };
  for (const k of keys) {
    batch[k] = small[k]!;
    bytes += small[k]!.length;
    if (bytes > 1_000_000 || Object.keys(batch).length >= 200) {
      await flush();
    }
  }
  await flush();
  await benchJson("POST", "/bench/objects", { [cur]: small[cur]! });
  const h = await head(m.tenant);
  if (h.current?.log_seq_start !== m.logSeqStart || h.current.snapshot !== m.snapshotKey) {
    throw new Error(`${m.tenant}: uploaded head does not match the manifest`);
  }
  console.log(
    `uploaded ${m.tenant}: ${m.smallObjects} small objects, snapshot ${m.snapshotBytes} B`,
  );
};

/**
 * FORCED fold arm. Each sample: check the fixture head, send the update whose
 * tick folds, wait for `log_seq_start` to advance (or time out), then restore
 * the fixture: drop the appended entry and the new snapshot, put the original
 * `current.json` back.
 */
const foldArm = async (m: CellManifest, n: number): Promise<void> => {
  if (m.kind !== "fold") {
    throw new Error(`${m.tenant}: the forced fold arm requires a fold cell`);
  }
  const small = JSON.parse(readFileSync(fixtureFile(m.smallFile), "utf8")) as Record<
    string,
    string
  >;
  const cur = currentJsonKey(m.tenant);
  const appended = cur.replace(/current\.json$/, `log/${m.logSeqStart + m.tailEntries}.json`);
  for (let i = 0; i < n; i++) {
    const before = await head(m.tenant);
    if (
      before.current?.log_seq_start !== m.logSeqStart ||
      before.current.snapshot !== m.snapshotKey
    ) {
      throw new Error(`${m.tenant}: fixture head is not the original before sample ${i}`);
    }
    const { status } = await measured(m, "fold", i, "PATCH");
    let after = before;
    const deadline = Date.now() + 120_000;
    await sleep(3000);
    while (Date.now() < deadline) {
      after = await head(m.tenant);
      if (after.current?.log_seq_start !== m.logSeqStart) {
        break;
      }
      await sleep(5000);
    }
    const folded = after.current?.log_seq_start !== m.logSeqStart;
    record({
      tenant: m.tenant,
      arm: "fold-check",
      i,
      tag: `${m.tenant}.fold.${i}`,
      writeStatus: status,
      folded,
      logSeqStart: after.current?.log_seq_start,
      snapshotBytes: after.current?.snapshot_bytes,
      meanEntryBytes: after.current?.mean_entry_bytes,
    });
    const drop = [appended];
    if (after.current !== null && after.current.snapshot !== m.snapshotKey) {
      drop.push(after.current.snapshot);
    }
    await benchJson("POST", "/bench/delete", drop);
    await benchJson("POST", "/bench/objects", { [cur]: small[cur]! });
    await sleep(2000);
  }
};

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "upload": {
    for (const t of args) {
      await upload(cell(t));
    }
    break;
  }
  case "read":
  case "update": {
    const m = cell(args[0]!);
    const n = Number(args[1] ?? 5);
    for (let i = 0; i < n; i++) {
      await measured(m, command, i, command === "read" ? "GET" : "PATCH");
      await sleep(1500);
    }
    break;
  }
  case "fold": {
    await foldArm(cell(args[0]!), Number(args[1] ?? 3));
    break;
  }
  case "head": {
    console.log(JSON.stringify(await head(args[0]!)));
    break;
  }
  case "wipe": {
    for (;;) {
      const r = await benchJson<{ deleted: number; done: boolean }>("POST", "/bench/wipe");
      console.log(`deleted ${r.deleted}`);
      if (r.done) {
        break;
      }
    }
    break;
  }
  default: {
    throw new Error(`unknown command ${command}`);
  }
}
