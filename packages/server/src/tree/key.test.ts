import { MAX_KEY_BYTES } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  collectionOfPrefix,
  isTreeAttempt,
  isTreeSha256,
  mintTreeAttempt,
  parseTreeNodeKey,
  parseTreeRecordKey,
  treeNodeKey,
  treeRecordKey,
} from "./key.ts";

const P = "app/helpdesk/tenant/acme/manifests/tickets";
const A1 = "00112233445566778899aabbccddeeff";
const SHA = "fbf6a6386499e42c43fec71fb62476ba684391288cc343204b8552dcc394ff61";
const KEY = `${P}/_v99/n/${A1}/${SHA}`;

describe("node key grammar", () => {
  test("a node key is <P>/_v99/n/<attempt>/<sha256>", () => {
    expect(treeNodeKey(P, A1, SHA)).toBe(
      "app/helpdesk/tenant/acme/manifests/tickets/_v99/n/00112233445566778899aabbccddeeff/fbf6a6386499e42c43fec71fb62476ba684391288cc343204b8552dcc394ff61",
    );
    expect(parseTreeNodeKey(P, KEY)).toEqual({ attempt: A1, sha256: SHA });
  });

  test.each([
    ["uppercase attempt", `${P}/_v99/n/${A1.toUpperCase()}/${SHA}`],
    ["uppercase sha256", `${P}/_v99/n/${A1}/${SHA.toUpperCase()}`],
    ["short attempt", `${P}/_v99/n/${A1.slice(1)}/${SHA}`],
    ["long attempt", `${P}/_v99/n/${A1}0/${SHA}`],
    ["short sha256", `${P}/_v99/n/${A1}/${SHA.slice(1)}`],
    ["long sha256", `${P}/_v99/n/${A1}/${SHA}0`],
    ["extension", `${P}/_v99/n/${A1}/${SHA}.json`],
    ["trailing slash", `${P}/_v99/n/${A1}/${SHA}/`],
    ["trailing newline", `${P}/_v99/n/${A1}/${SHA}\n`],
    ["extra segment", `${P}/_v99/n/${A1}/x/${SHA}`],
    ["missing attempt", `${P}/_v99/n/${SHA}`],
    ["other version segment", `${P}/_v98/n/${A1}/${SHA}`],
    ["other kind segment", `${P}/_v99/m/${A1}/${SHA}`],
    ["other collection", `app/helpdesk/tenant/acme/manifests/ticketz/_v99/n/${A1}/${SHA}`],
    ["prefix of the collection", `app/helpdesk/tenant/acme/manifests/ticket/_v99/n/${A1}/${SHA}`],
    ["deeper prefix", `${P}/x/_v99/n/${A1}/${SHA}`],
    ["GC state", `${P}/_v99/gc-pending.json`],
    ["fold record", `${P}/_v99/r/0000000000000007/${A1}/${SHA}`],
    ["leading slash", `/${KEY}`],
    ["non-hex attempt", `${P}/_v99/n/${A1.slice(0, 31)}g/${SHA}`],
    ["sha-512 width", `${P}/_v99/n/${A1}/${SHA}${SHA}`],
  ])("%s does not parse", (_label, key) => {
    expect(parseTreeNodeKey(P, key)).toBeNull();
  });

  test("treeNodeKey refuses a malformed attempt or hash as an internal bug", () => {
    expect(() => treeNodeKey(P, A1.toUpperCase(), SHA)).toThrow(
      expect.objectContaining({ code: "Internal" }),
    );
    expect(() => treeNodeKey(P, A1, SHA.slice(2))).toThrow(
      expect.objectContaining({ code: "Internal" }),
    );
  });

  test("the longest valid prefix gives a key within the storage key ceiling", () => {
    // Each name segment is capped at 256 bytes, so P is at most 791 bytes
    // and a node key at most 896.
    const name = "é".repeat(128);
    const longest = `app/${name}/tenant/${name}/manifests/${name}`;
    expect(new TextEncoder().encode(longest).byteLength).toBe(791);
    const key = treeNodeKey(longest, A1, SHA);
    expect(new TextEncoder().encode(key).byteLength).toBe(896);
    expect(896).toBeLessThanOrEqual(MAX_KEY_BYTES);
  });

  test("a key over the storage key ceiling is refused as InvalidConfig", () => {
    expect(() => treeNodeKey(`app/${"a".repeat(1000)}/manifests/c`, A1, SHA)).toThrow(
      expect.objectContaining({ code: "InvalidConfig" }),
    );
  });

  test("the collection is the prefix's last segment, and must be a valid name", () => {
    expect(collectionOfPrefix(P)).toBe("tickets");
    expect(collectionOfPrefix("tickets")).toBe("tickets");
    for (const bad of [`${P}/`, "app/_reserved", "app/.."]) {
      expect(() => collectionOfPrefix(bad)).toThrow(
        expect.objectContaining({ code: "InvalidConfig" }),
      );
    }
  });
});

describe("fold-record key grammar", () => {
  const RECORD = `${P}/_v99/r/0000000000000007/${A1}/${SHA}`;

  test("a record key is <P>/_v99/r/<floor16>/<attempt>/<sha256>", () => {
    expect(treeRecordKey(P, 7, A1, SHA)).toBe(RECORD);
    expect(parseTreeRecordKey(P, RECORD)).toEqual({ floor: 7, attempt: A1, sha256: SHA });
    const max = treeRecordKey(P, Number.MAX_SAFE_INTEGER, A1, SHA);
    expect(max).toBe(`${P}/_v99/r/9007199254740991/${A1}/${SHA}`);
    expect(parseTreeRecordKey(P, max)?.floor).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("record keys sort by floor, then by attempt", () => {
    const keys = [
      treeRecordKey(P, 10, A1, SHA),
      treeRecordKey(P, 9, "f".repeat(32), SHA),
      treeRecordKey(P, 9, A1, SHA),
    ];
    expect(keys.toSorted().map((key) => parseTreeRecordKey(P, key))).toEqual([
      { floor: 9, attempt: A1, sha256: SHA },
      { floor: 9, attempt: "f".repeat(32), sha256: SHA },
      { floor: 10, attempt: A1, sha256: SHA },
    ]);
  });

  test.each([
    ["a node key", KEY],
    ["15-digit floor", `${P}/_v99/r/000000000000007/${A1}/${SHA}`],
    ["17-digit floor", `${P}/_v99/r/00000000000000007/${A1}/${SHA}`],
    ["floor past the safe integers", `${P}/_v99/r/9007199254740992/${A1}/${SHA}`],
    ["signed floor", `${P}/_v99/r/-000000000000007/${A1}/${SHA}`],
    ["uppercase attempt", `${P}/_v99/r/0000000000000007/${A1.toUpperCase()}/${SHA}`],
    ["short sha256", `${P}/_v99/r/0000000000000007/${A1}/${SHA.slice(1)}`],
    ["extension", `${RECORD}.json`],
    ["missing floor", `${P}/_v99/r/${A1}/${SHA}`],
    ["other version segment", `${P}/_v98/r/0000000000000007/${A1}/${SHA}`],
    ["other collection", RECORD.replace("/tickets/", "/ticketz/")],
    ["GC state", `${P}/_v99/gc-pending.json`],
  ])("%s does not parse as a record key", (_label, key) => {
    expect(parseTreeRecordKey(P, key)).toBeNull();
  });

  test("treeRecordKey refuses a malformed floor, attempt or hash as an internal bug", () => {
    for (const build of [
      () => treeRecordKey(P, -1, A1, SHA),
      () => treeRecordKey(P, 1.5, A1, SHA),
      () => treeRecordKey(P, 2 ** 53, A1, SHA),
      () => treeRecordKey(P, 1, A1.slice(1), SHA),
      () => treeRecordKey(P, 1, A1, SHA.toUpperCase()),
    ]) {
      expect(build).toThrow(expect.objectContaining({ code: "Internal" }));
    }
  });

  test("the longest valid prefix gives a record key within the storage key ceiling", () => {
    const name = "é".repeat(128);
    const longest = `app/${name}/tenant/${name}/manifests/${name}`;
    const key = treeRecordKey(longest, Number.MAX_SAFE_INTEGER, A1, SHA);
    expect(new TextEncoder().encode(key).byteLength).toBe(913);
    expect(913).toBeLessThanOrEqual(MAX_KEY_BYTES);
  });
});

describe("attempt identity", () => {
  test("a minted attempt is 32 lowercase hex characters, fresh each call", () => {
    const minted = new Set(Array.from({ length: 64 }, mintTreeAttempt));
    expect(minted.size).toBe(64);
    for (const attempt of minted) {
      expect(isTreeAttempt(attempt)).toBe(true);
    }
  });

  test("attempt and hash predicates accept only exact lowercase hex", () => {
    expect(isTreeAttempt(A1)).toBe(true);
    expect(isTreeAttempt(A1.toUpperCase())).toBe(false);
    expect(isTreeAttempt(`${A1}\n`)).toBe(false);
    expect(isTreeAttempt(42)).toBe(false);
    expect(isTreeSha256(SHA)).toBe(true);
    expect(isTreeSha256(A1)).toBe(false);
  });
});
