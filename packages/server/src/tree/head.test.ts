import { BaerlyError, encodeJsonBytes, MemoryStorage } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { logStateCurrentJson } from "../../../../tests/fixtures/log-state.ts";
import { TREE_TEST_CHUNK_SALT, testChunkKey } from "../../../../tests/fixtures/tree-chunk-salt.ts";
import { buildTree, sealTree } from "./build.ts";
import { chunkHash } from "./chunk.ts";
import {
  assertRootMatchesHead,
  importTreeChunkKey,
  parseTreeHead,
  readTreeHead,
  readTreeRoot,
  treeHeadKey,
} from "./head.ts";
import { canonicalDocument } from "./node-codec.ts";

const P = "app/helpdesk/tenant/acme/manifests/tickets";
const ATTEMPT = "00112233445566778899aabbccddeeff";
const OTHER_KEY = `app/helpdesk/tenant/acme/manifests/other/_v99/n/${ATTEMPT}/${"a".repeat(64)}`;

/** A sealed two-row root leaf at floor 2, and its storage. */
const seededRoot = async () => {
  const docs = [{ _id: "a" }, { _id: "b", n: 1 }].map((d) => canonicalDocument(d, "test"));
  const sealed = await sealTree(await buildTree(docs, await testChunkKey()), {
    prefix: P,
    attempt: ATTEMPT,
    floor: 2,
  });
  const root = sealed.root!;
  const storage = new MemoryStorage();
  await storage.put(root.key, root.bytes);
  return { storage, root };
};

const treeHeadJson = (overrides: Record<string, unknown> = {}, tree?: unknown) => ({
  ...logStateCurrentJson({ log_seq_start: 2, tail_hint: 2 }),
  proto_tree: tree ?? { root: null, attempt: ATTEMPT, chunk_salt: TREE_TEST_CHUNK_SALT },
  ...overrides,
});

const parse = (json: unknown) =>
  parseTreeHead(P, { json: json as ReturnType<typeof logStateCurrentJson>, etag: '"e"' });

const invalidResponse = (run: () => unknown): BaerlyError => {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BaerlyError);
  expect((caught as BaerlyError).code).toBe("InvalidResponse");
  return caught as BaerlyError;
};

describe("tree head", () => {
  test("a fresh head without proto_tree is an empty tree with no salt", async () => {
    const head = parse(logStateCurrentJson());
    expect(head).toMatchObject({ root: null, attempt: null });
    expect(head.json.proto_tree).toBeUndefined();
    expect(head.key).toBe(treeHeadKey(P));
    await expect(importTreeChunkKey(head)).resolves.toBeNull();
  });

  test("a valid head names its root and installer, and its salt imports as the chunk key", async () => {
    const { root } = await seededRoot();
    const head = parse(
      treeHeadJson(
        { snapshot_rows: 2, snapshot_bytes: root.summary.bytes },
        { attempt: ATTEMPT, chunk_salt: TREE_TEST_CHUNK_SALT, root: root.key },
      ),
    );
    expect(head).toMatchObject({ root: root.key, attempt: ATTEMPT });
    expect(head).not.toHaveProperty("chunkSalt");
    const key = (await importTreeChunkKey(head))!;
    const expected = await testChunkKey();
    await expect(chunkHash(key, 0, "k1")).resolves.toBe(await chunkHash(expected, 0, "k1"));
  });

  test("a folded head with a null root is an empty tree", () => {
    const head = parse(treeHeadJson());
    expect(head).toMatchObject({ root: null, attempt: ATTEMPT });
    expect(head.json.proto_tree).toBeDefined();
  });

  const salt = TREE_TEST_CHUNK_SALT;
  const cases: readonly (readonly [string, unknown])[] = [
    ["snapshot is not null", treeHeadJson({ snapshot: `${P}/snapshot/L0/x.json` })],
    [
      "proto_tree is missing on a folded head",
      { ...logStateCurrentJson({ log_seq_start: 3, tail_hint: 3 }) },
    ],
    [
      "proto_tree is missing on a head with rows",
      { ...logStateCurrentJson({ snapshot_rows: 1, snapshot_bytes: 11 }) },
    ],
    ["proto_tree is null", treeHeadJson({ proto_tree: null })],
    ["proto_tree is an array", treeHeadJson({ proto_tree: [] })],
    [
      "proto_tree has an extra field",
      treeHeadJson({}, { root: null, attempt: ATTEMPT, chunk_salt: salt, extra: 1 }),
    ],
    ["proto_tree lacks chunk_salt", treeHeadJson({}, { root: null, attempt: ATTEMPT })],
    ["proto_tree lacks root", treeHeadJson({}, { attempt: ATTEMPT, chunk_salt: salt })],
    [
      "chunk_salt is uppercase",
      treeHeadJson({}, { root: null, attempt: ATTEMPT, chunk_salt: salt.toUpperCase() }),
    ],
    [
      "chunk_salt is 31 characters",
      treeHeadJson({}, { root: null, attempt: ATTEMPT, chunk_salt: salt.slice(1) }),
    ],
    [
      "chunk_salt is 33 characters",
      treeHeadJson({}, { root: null, attempt: ATTEMPT, chunk_salt: `${salt}0` }),
    ],
    ["chunk_salt is a number", treeHeadJson({}, { root: null, attempt: ATTEMPT, chunk_salt: 1 })],
    ["proto_tree lacks attempt", treeHeadJson({}, { root: null, chunk_salt: salt })],
    ["attempt is null", treeHeadJson({}, { root: null, attempt: null, chunk_salt: salt })],
    [
      "attempt is uppercase",
      treeHeadJson({}, { root: null, attempt: ATTEMPT.toUpperCase(), chunk_salt: salt }),
    ],
    [
      "attempt is 31 characters",
      treeHeadJson({}, { root: null, attempt: ATTEMPT.slice(1), chunk_salt: salt }),
    ],
    ["attempt is a number", treeHeadJson({}, { root: null, attempt: 0, chunk_salt: salt })],
    ["root is a number", treeHeadJson({}, { root: 1, attempt: ATTEMPT, chunk_salt: salt })],
    [
      "root is under another collection",
      treeHeadJson({}, { root: OTHER_KEY, attempt: ATTEMPT, chunk_salt: salt }),
    ],
    [
      "root is not a node key",
      treeHeadJson({}, { root: `${P}/_v99/gc-pending.json`, attempt: ATTEMPT, chunk_salt: salt }),
    ],
    [
      "a null root has totals",
      treeHeadJson({ snapshot_rows: 1 }, { root: null, attempt: ATTEMPT, chunk_salt: salt }),
    ],
  ];

  test.each(cases)("%s is InvalidResponse, and the message holds no salt", (_name, json) => {
    const error = invalidResponse(() => parse(json));
    expect(error.message).not.toContain(salt);
    expect(error.message).not.toContain(salt.toUpperCase());
    expect(error.message).not.toContain(salt.slice(1));
  });

  test("a malformed salt is named, never echoed", () => {
    const secret = "fedcba9876543210fedcba987654321";
    const error = invalidResponse(() =>
      parse(treeHeadJson({}, { root: null, attempt: ATTEMPT, chunk_salt: secret })),
    );
    expect(error.message).toContain("proto_tree.chunk_salt");
    expect(error.message).not.toContain(secret);
  });

  test("readTreeHead reads current.json with its ETag, and returns null when there is none", async () => {
    const storage = new MemoryStorage();
    await expect(readTreeHead(storage, P)).resolves.toBeNull();
    const { etag } = await storage.put(treeHeadKey(P), encodeJsonBytes(logStateCurrentJson()));
    await expect(readTreeHead(storage, P)).resolves.toMatchObject({ root: null, etag });
    await storage.put(treeHeadKey(P), encodeJsonBytes(treeHeadJson({ snapshot: "x" })));
    await expect(readTreeHead(storage, P)).rejects.toMatchObject({ code: "InvalidResponse" });
  });
});

describe("tree root", () => {
  const headFor = (rootKey: string, overrides: Record<string, unknown>) =>
    parse(
      treeHeadJson(overrides, {
        root: rootKey,
        attempt: ATTEMPT,
        chunk_salt: TREE_TEST_CHUNK_SALT,
      }),
    );

  test("the root decodes against the head's floor and totals", async () => {
    const { storage, root } = await seededRoot();
    const head = headFor(root.key, { snapshot_rows: 2, snapshot_bytes: root.summary.bytes });
    const decoded = await readTreeRoot(storage, head);
    expect(decoded?.key).toBe(root.key);
    expect(decoded?.node.root).toEqual({ floor: 2, rows: 2, bytes: root.summary.bytes });
  });

  test("a null root fetches nothing", async () => {
    const storage = new MemoryStorage();
    await expect(readTreeRoot(storage, parse(treeHeadJson()))).resolves.toBeNull();
  });

  test.each([
    ["the floor differs", { log_seq_start: 1, tail_hint: 1 }],
    ["snapshot_rows differs", { snapshot_rows: 3 }],
    ["snapshot_bytes differs", { snapshot_bytes: 1 }],
  ])("%s: InvalidResponse", async (_name, overrides) => {
    const { storage, root } = await seededRoot();
    const head = headFor(root.key, {
      snapshot_rows: 2,
      snapshot_bytes: root.summary.bytes,
      ...overrides,
    });
    await expect(readTreeRoot(storage, head)).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("a missing root fails its present check", async () => {
    const { root } = await seededRoot();
    const head = headFor(root.key, { snapshot_rows: 2, snapshot_bytes: root.summary.bytes });
    await expect(readTreeRoot(new MemoryStorage(), head)).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringContaining("present check failed"),
    });
  });

  test("a captured root whose floor is not the head's is InvalidResponse", async () => {
    const { storage, root } = await seededRoot();
    const decoded = await readTreeRoot(
      storage,
      headFor(root.key, { snapshot_rows: 2, snapshot_bytes: root.summary.bytes }),
    );
    const moved = headFor(root.key, {
      snapshot_rows: 2,
      snapshot_bytes: root.summary.bytes,
      log_seq_start: 3,
      tail_hint: 3,
    });
    expect(() => assertRootMatchesHead(moved, decoded)).toThrow(
      expect.objectContaining({ code: "InvalidResponse" }),
    );
  });

  test("a captured root that is not the head's, or not decoded as a root, is Internal", async () => {
    const { storage, root } = await seededRoot();
    const head = headFor(root.key, { snapshot_rows: 2, snapshot_bytes: root.summary.bytes });
    const decoded = (await readTreeRoot(storage, head))!;
    const internal = expect.objectContaining({ code: "Internal" });
    expect(() => assertRootMatchesHead(head, null)).toThrow(internal);
    expect(() => assertRootMatchesHead(parse(treeHeadJson()), decoded)).toThrow(internal);
    expect(() =>
      assertRootMatchesHead(head, { ...decoded, node: { ...decoded.node, root: null } }),
    ).toThrow(internal);
  });
});
