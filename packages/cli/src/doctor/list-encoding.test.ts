import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsStorage } from "@baerly/dev";
import {
  BaerlyError,
  MemoryStorage,
  type Storage,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { runDoctor } from "../doctor.ts";
import { captureStream } from "../_internal/testing.ts";
import { doctorListEncoding, LIST_ENTRY_LIMIT } from "./list-encoding.ts";

// The wire shape of an S3 `encoding-type=url` key: percent-encoded, space as `+`.
const s3Encode = (k: string): string =>
  encodeURIComponent(k).replace(/%20/g, "+").replace(/%2F/g, "/");
// The same, from a backend that leaves literal `+` unencoded.
const s3EncodeKeepPlus = (k: string): string => s3Encode(k).replace(/%2B/g, "+");
// The adapters' decode step (`packages/adapter-node/src/xml.ts`).
const adapterDecode = (k: string): string => {
  try {
    return decodeURIComponent(k.replace(/\+/g, " "));
  } catch {
    throw new BaerlyError("InvalidResponse", `Malformed percent-escape in S3 <Key>: ${k}`);
  }
};

/** Memory storage whose LIST hands back `rewrite(key)` instead of the stored key. */
class RewritingListStorage extends MemoryStorage {
  private readonly rewrite: (key: string) => string;
  constructor(rewrite: (key: string) => string) {
    super();
    this.rewrite = rewrite;
  }
  override async *list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    for await (const entry of super.list(prefix, opts)) {
      yield { key: this.rewrite(entry.key), etag: entry.etag };
    }
  }
}

/** Counts every storage call and records deletes. */
class RecordingStorage extends MemoryStorage {
  puts = 0;
  lists = 0;
  deletes: string[] = [];
  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    this.puts += 1;
    return super.put(key, body, opts);
  }
  override list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    this.lists += 1;
    return super.list(prefix, opts);
  }
  override async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    this.deletes.push(key);
    return super.delete(key, opts);
  }
}

const listAll = async (storage: Storage): Promise<string[]> => {
  const keys: string[] = [];
  for await (const e of storage.list("")) {
    keys.push(e.key);
  }
  return keys;
};

const byCheck = (report: Awaited<ReturnType<typeof doctorListEncoding>>, check: string) =>
  report.findings.find((f) => f.check === check);

describe("doctorListEncoding — conformant adapters", () => {
  test("memory: both sentinels list byte-exact, six storage ops, nothing left behind", async () => {
    const storage = new RecordingStorage();
    const report = await doctorListEncoding(storage, "app/");
    expect(report.status).toBe("ok");
    expect(report.findings.map((f) => [f.check, f.severity])).toEqual([
      ["list-encoding-escapes", "ok"],
      ["list-encoding-bare-percent", "ok"],
    ]);
    expect({ puts: storage.puts, lists: storage.lists, deletes: storage.deletes.length }).toEqual({
      puts: 2,
      lists: 2,
      deletes: 2,
    });
    expect(storage.deletes.every((k) => k.startsWith("app/__baerly_list_probe__/"))).toBe(true);
    await expect(listAll(storage)).resolves.toEqual([]);
  });

  test("local-fs: both sentinels list byte-exact and are cleaned up", async () => {
    const root = await mkdtemp(join(tmpdir(), "baerly-list-probe-"));
    try {
      const storage = new LocalFsStorage({ root });
      const report = await doctorListEncoding(storage, "");
      expect(report.findings.filter((f) => f.severity !== "ok")).toEqual([]);
      await expect(listAll(storage)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("doctorListEncoding — mis-encoding backends", () => {
  test("missing decoding: keys come back still URL-encoded", async () => {
    const report = await doctorListEncoding(new RewritingListStorage(s3Encode), "");
    expect(report.status).toBe("error");
    for (const check of ["list-encoding-escapes", "list-encoding-bare-percent"]) {
      const f = byCheck(report, check);
      expect(f?.severity).toBe("error");
      expect(f?.message).toContain("not decoded");
      expect(f?.fix).toContain("encoding-type=url");
    }
  });

  test("double decoding: backend ignores encoding-type=url, client decodes raw keys", async () => {
    const report = await doctorListEncoding(new RewritingListStorage(adapterDecode), "");
    expect(report.status).toBe("error");
    expect(byCheck(report, "list-encoding-escapes")?.message).toContain("double decoded");
    // A bare `%` cannot be decoded at all, so LIST itself fails.
    const bare = byCheck(report, "list-encoding-bare-percent");
    expect(bare?.severity).toBe("error");
    expect(bare?.message).toContain("ignores `encoding-type=url`");
  });

  test("double decoding: client decodes a correctly encoded key twice", async () => {
    const twice = (k: string): string => adapterDecode(adapterDecode(s3Encode(k)));
    const report = await doctorListEncoding(new RewritingListStorage(twice), "");
    expect(byCheck(report, "list-encoding-escapes")?.message).toContain("double decoded");
    expect(byCheck(report, "list-encoding-bare-percent")?.severity).toBe("error");
  });

  test("wrong decoding: `+` left as `+` instead of space", async () => {
    const plain = (k: string): string => decodeURIComponent(s3Encode(k));
    const report = await doctorListEncoding(new RewritingListStorage(plain), "");
    expect(byCheck(report, "list-encoding-escapes")?.message).toContain("`+` not decoded to space");
    expect(byCheck(report, "list-encoding-bare-percent")?.severity).toBe("error");
  });

  test("wrong encoding: backend leaves literal `+` unencoded", async () => {
    const keepPlus = (k: string): string => adapterDecode(s3EncodeKeepPlus(k));
    const report = await doctorListEncoding(new RewritingListStorage(keepPlus), "");
    expect(byCheck(report, "list-encoding-escapes")?.message).toContain(
      "literal `+` decoded to space",
    );
    expect(byCheck(report, "list-encoding-bare-percent")?.severity).toBe("ok");
  });

  test("wrong decoding: XML entities left in the key", async () => {
    const escaped = (k: string): string =>
      k.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const report = await doctorListEncoding(
      new RewritingListStorage((k) => escaped(k).replace(/"/g, "&quot;").replace(/'/g, "&apos;")),
      "",
    );
    expect(byCheck(report, "list-encoding-escapes")?.message).toContain(
      "XML entities not unescaped",
    );
  });

  test("wrong decoding: UTF-8 decoded as Latin-1 reports the first differing byte", async () => {
    const latin1 = (k: string): string => String.fromCharCode(...new TextEncoder().encode(k));
    const report = await doctorListEncoding(new RewritingListStorage(latin1), "");
    const f = byCheck(report, "list-encoding-escapes");
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("wrong decoding");
    expect(f?.message).toMatch(/offset \d+/);
    // The bare-percent sentinel is pure ASCII, so it survives.
    expect(byCheck(report, "list-encoding-bare-percent")?.severity).toBe("ok");
  });

  test("sentinel absent from LIST", async () => {
    class EmptyList extends MemoryStorage {
      override async *list(): AsyncIterable<StorageListEntry> {}
    }
    const report = await doctorListEncoding(new EmptyList(), "");
    expect(byCheck(report, "list-encoding-escapes")?.message).toContain("did not return");
  });
});

describe("doctorListEncoding — bounds and cleanup", () => {
  test("an endless LIST is cut off at LIST_ENTRY_LIMIT entries", async () => {
    let yielded = 0;
    class Endless extends MemoryStorage {
      override async *list(prefix: string): AsyncIterable<StorageListEntry> {
        for (;;) {
          yielded += 1;
          yield { key: `${prefix}junk-${yielded}`, etag: '"x"' };
        }
      }
    }
    const report = await doctorListEncoding(new Endless(), "");
    expect(report.status).toBe("error");
    expect(yielded).toBeLessThanOrEqual(2 * LIST_ENTRY_LIMIT);
  });

  test("LIST throwing still deletes every sentinel", async () => {
    class ListThrows extends RecordingStorage {
      override list(): AsyncIterable<StorageListEntry> {
        throw new BaerlyError("NetworkError", "connection reset");
      }
    }
    const storage = new ListThrows();
    const report = await doctorListEncoding(storage, "");
    expect(report.status).toBe("error");
    expect(byCheck(report, "list-encoding-escapes")?.message).toContain("connection reset");
    expect(storage.deletes.length).toBe(2);
  });

  test("PUT throwing still deletes every attempted sentinel", async () => {
    class SecondPutThrows extends RecordingStorage {
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (this.puts === 1) {
          this.puts += 1;
          throw new BaerlyError("AccessDenied", "key rejected");
        }
        return super.put(key, body, opts);
      }
    }
    const storage = new SecondPutThrows();
    const report = await doctorListEncoding(storage, "");
    expect(byCheck(report, "list-encoding-escapes")?.severity).toBe("ok");
    const bare = byCheck(report, "list-encoding-bare-percent");
    expect(bare?.severity).toBe("error");
    expect(bare?.message).toContain("key rejected");
    expect(storage.deletes.length).toBe(2);
    await expect(listAll(storage)).resolves.toEqual([]);
  });

  test("a failed cleanup delete is reported as a warning naming the key", async () => {
    class DeleteThrows extends MemoryStorage {
      override async delete(): Promise<void> {
        throw new BaerlyError("NetworkError", "delete timed out");
      }
    }
    const report = await doctorListEncoding(new DeleteThrows(), "");
    expect(report.status).toBe("warning");
    const cleanup = report.findings.filter((f) => f.check === "list-encoding-cleanup");
    expect(cleanup.length).toBe(2);
    expect(cleanup.every((f) => f.severity === "warning")).toBe(true);
    expect(cleanup[0]?.message).toContain("__baerly_list_probe__/");
    expect(cleanup[0]?.message).toContain("delete timed out");
  });
});

describe("baerly doctor --bucket", () => {
  test("reports the CAS and list-encoding checks together", async () => {
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runDoctor(["--bucket=memory://doctor-list-encoding", "--json"]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { status: string; findings: Array<{ check: string; severity: string }> };
    };
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.findings.map((f) => f.check)).toEqual(
      expect.arrayContaining([
        "cas-ifMatch-stale",
        "list-encoding-escapes",
        "list-encoding-bare-percent",
      ]),
    );
  });
});
