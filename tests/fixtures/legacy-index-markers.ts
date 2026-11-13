/**
 * Legacy index markers: the zero-byte objects writers before 0.7 PUT
 * under `<collection>/index/` for every declared index. 0.7 writers emit
 * none and nothing reads them, so a bucket upgraded from an earlier
 * release holds them as inert objects. Tests seed them to prove they
 * change no read result and no storage call.
 *
 * The key shape and value encoding reproduce the pre-0.7 writer byte for
 * byte, so a seeded corpus looks exactly like an upgraded bucket:
 *
 *   `<collectionPrefix>/index/<indexName>/<v0-b32>[/<v1-b32>…]/<docId>.json`
 *
 * where each value is a type-tagged byte stream in lowercase RFC 4648
 * base-32 (`[0-9a-v]`).
 */

import type { DocumentData, IndexDefinition, Storage } from "@baerly/protocol";

const B32_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

const typedBytes = (v: unknown): Uint8Array => {
  if (v === null || v === undefined) {
    return new Uint8Array([0x10]);
  }
  if (v === false) {
    return new Uint8Array([0x20]);
  }
  if (v === true) {
    return new Uint8Array([0x21]);
  }
  if (typeof v === "number") {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, v === 0 ? 0 : v, false);
    const bytes = new Uint8Array(buf);
    if ((bytes[0]! & 0x80) === 0) {
      bytes[0] = bytes[0]! ^ 0x80;
    } else {
      for (let i = 0; i < 8; i++) {
        bytes[i] = bytes[i]! ^ 0xff;
      }
    }
    return new Uint8Array([0x30, ...bytes]);
  }
  const tag = typeof v === "string" ? 0x40 : 0x50;
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return new Uint8Array([tag, ...new TextEncoder().encode(text)]);
};

/** The pre-0.7 writer's path segment for one indexed value. */
export const legacyIndexValueSegment = (v: unknown): string => {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of typedBytes(v)) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
};

/**
 * The marker keys a pre-0.7 writer PUT for `body` under `defs`: one per
 * index whose fields are all set (and whose `predicate`, if any, the test
 * caller has already decided holds). Array and dotted fields are skipped.
 */
export const legacyIndexMarkerKeys = (
  collectionPrefix: string,
  defs: ReadonlyArray<IndexDefinition>,
  body: DocumentData,
  docId: string,
): string[] => {
  const keys: string[] = [];
  for (const def of defs) {
    const fields = typeof def.on === "string" ? [def.on] : def.on;
    const values = fields.map((f) => body[f]);
    if (values.some((v) => v === null || v === undefined || Array.isArray(v))) {
      continue;
    }
    const segments = values.map(legacyIndexValueSegment).join("/");
    keys.push(`${collectionPrefix}/index/${def.name}/${segments}/${docId}.json`);
  }
  return keys;
};

/** PUT each key as a zero-byte object, as the pre-0.7 writer did. */
export const seedLegacyIndexMarkers = async (
  storage: Storage,
  keys: readonly string[],
): Promise<void> => {
  for (const key of keys) {
    await storage.put(key, new Uint8Array(0), { contentType: "application/json" });
  }
};

/** Every object under `<collectionPrefix>/index/`. */
export const listIndexObjects = async (
  storage: Storage,
  collectionPrefix: string,
): Promise<string[]> => {
  const keys: string[] = [];
  for await (const entry of storage.list(`${collectionPrefix}/index/`)) {
    keys.push(entry.key);
  }
  return keys;
};
