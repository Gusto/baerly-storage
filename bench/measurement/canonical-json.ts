import { sha256Hex as protocolSha256Hex } from "@baerly/protocol";

export const CANONICAL_JSON_VERSION = "baerly-canonical-json-v1" as const;
export const CANONICAL_JSON_VECTOR_CORPUS_DIGEST =
  "2f7eecfc4324c311d306db52eb4589d628df835a3e76a9715e290ad099ef7d01" as const;
export const CANONICAL_JSON_MAX_DEPTH = 256;

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export type CanonicalJsonRejectionReason =
  | "undefined-value"
  | "function-value"
  | "symbol-value"
  | "bigint-value"
  | "non-finite-number"
  | "non-ijson-string"
  | "non-plain-object"
  | "cyclic-reference"
  | "array-hole"
  | "array-extra-property"
  | "symbol-key"
  | "forbidden-key"
  | "non-enumerable-own-property"
  | "accessor-own-property"
  | "max-depth-exceeded"
  | "serialization-failed";

export class CanonicalJsonError extends Error {
  readonly code = "CanonicalJsonError" as const;
  readonly reason: CanonicalJsonRejectionReason;
  readonly path: string;

  constructor(reason: CanonicalJsonRejectionReason, path: string, cause?: unknown) {
    super(
      `Canonical JSON rejected ${reason} at ${path}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "CanonicalJsonError";
    this.reason = reason;
    this.path = path;
  }
}

interface OwnDataProperty {
  readonly key: string;
  readonly value: unknown;
}

const IDENTIFIER_NAME = /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u;
const UTF8_ENCODER = new TextEncoder();

const reject = (reason: CanonicalJsonRejectionReason, path: string): never => {
  throw new CanonicalJsonError(reason, path);
};

const propertyPath = (parent: string, key: string): string => {
  if (key !== "__proto__" && IDENTIFIER_NAME.test(key)) {
    return `${parent}.${key}`;
  }
  return `${parent}[${JSON.stringify(key)}]`;
};

const compareUtf16 = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const assertIjsonString = (value: string, path: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const leading = value.charCodeAt(index);
    let codePoint = leading;
    if (leading >= 0xd800 && leading <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || trailing < 0xdc00 || trailing > 0xdfff) {
        reject("non-ijson-string", path);
      }
      codePoint = (leading - 0xd800) * 0x400 + trailing - 0xdc00 + 0x10000;
      index += 1;
    } else if (leading >= 0xdc00 && leading <= 0xdfff) {
      reject("non-ijson-string", path);
    }

    const isNoncharacter =
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) >= 0xfffe;
    if (isNoncharacter) {
      reject("non-ijson-string", path);
    }
  }
};

const isArrayIndex = (key: string, length: number): boolean => {
  if (key === "0") {
    return length > 0;
  }
  if (!/^[1-9]\d*$/.test(key)) {
    return false;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index < length;
};

const ownDataProperties = (
  container: object,
  path: string,
  arrayLength?: number,
): readonly OwnDataProperty[] => {
  const keys = Reflect.ownKeys(container);
  if (keys.some((key) => typeof key === "symbol")) {
    reject("symbol-key", path);
  }

  // Validate in canonical key order, NOT `Reflect.ownKeys` order. `ownKeys`
  // yields non-index string keys in property-insertion order, so validating in
  // that order would make the reported `reason` and `path` depend on how the
  // caller happened to build the object: `{a: <non-enumerable>, b: <getter>}`
  // and `{b: <getter>, a: <non-enumerable>}` describe the same value but would
  // disagree about what is wrong with it. Accepted output is already
  // insertion-order independent (objects emit in this same sorted order, arrays
  // emit by index), and sorting here extends that determinism to the rejection
  // path — which is the half a cross-language port has to reproduce from the
  // vector corpus.
  const stringKeys = keys
    .filter((key): key is string => typeof key === "string")
    .filter((key) => arrayLength === undefined || key !== "length")
    .toSorted(compareUtf16);

  const properties: OwnDataProperty[] = [];
  for (const ownKey of stringKeys) {
    const childPath =
      arrayLength !== undefined && isArrayIndex(ownKey, arrayLength)
        ? `${path}[${ownKey}]`
        : propertyPath(path, ownKey);
    assertIjsonString(ownKey, childPath);
    const descriptor = Object.getOwnPropertyDescriptor(container, ownKey);
    if (descriptor === undefined) {
      throw new CanonicalJsonError("non-plain-object", path);
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      reject("accessor-own-property", childPath);
    }
    if (descriptor.enumerable !== true) {
      reject("non-enumerable-own-property", childPath);
    }
    if (ownKey === "__proto__") {
      reject("forbidden-key", childPath);
    }
    if (arrayLength !== undefined && !isArrayIndex(ownKey, arrayLength)) {
      reject("array-extra-property", childPath);
    }
    properties.push({ key: ownKey, value: descriptor.value });
  }
  return properties;
};

const serialize = (value: unknown, path: string, depth: number, ancestors: Set<object>): string => {
  if (depth > CANONICAL_JSON_MAX_DEPTH) {
    reject("max-depth-exceeded", path);
  }

  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "undefined": {
      return reject("undefined-value", path);
    }
    case "function": {
      return reject("function-value", path);
    }
    case "symbol": {
      return reject("symbol-value", path);
    }
    case "bigint": {
      return reject("bigint-value", path);
    }
    case "boolean": {
      return JSON.stringify(value) as string;
    }
    case "string": {
      assertIjsonString(value, path);
      return JSON.stringify(value) as string;
    }
    case "number": {
      if (!Number.isFinite(value)) {
        reject("non-finite-number", path);
      }
      return Object.is(value, -0) ? "0" : (JSON.stringify(value) as string);
    }
    case "object": {
      break;
    }
  }

  if (ancestors.has(value)) {
    reject("cyclic-reference", path);
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (Object.getOwnPropertyDescriptor(value, String(index)) === undefined) {
        reject("array-hole", `${path}[${index}]`);
      }
    }

    const properties = ownDataProperties(value, path, value.length);
    const byIndex = new Map(properties.map((property) => [property.key, property.value]));
    ancestors.add(value);
    try {
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        encoded.push(
          serialize(byIndex.get(String(index)), `${path}[${index}]`, depth + 1, ancestors),
        );
      }
      return `[${encoded.join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject("non-plain-object", path);
  }

  // Already in canonical key order — `ownDataProperties` sorts so that
  // validation and emission share one ordering source.
  const properties = ownDataProperties(value, path);
  ancestors.add(value);
  try {
    const encoded = properties.map(({ key, value: child }) => {
      const childPath = propertyPath(path, key);
      return `${JSON.stringify(key)}:${serialize(child, childPath, depth + 1, ancestors)}`;
    });
    return `{${encoded.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

/**
 * Serialize a value to its canonical JSON bytes, or throw `CanonicalJsonError`.
 *
 * The `catch` is a totality guarantee, not error handling. `CANONICAL_JSON_MAX_DEPTH`
 * bounds nesting, but nothing bounds OUTPUT SIZE, and a shared acyclic
 * reference — which this module deliberately accepts — expands multiplicatively:
 * 26 distinct objects nested 26 deep, a tenth of the depth limit, produce over
 * 512 MB of output and V8 throws a bare `RangeError: Invalid string length`
 * from `JSON.stringify` or `Array.prototype.join`. One legal 90M-character
 * string reaches the same place. Rewrapping keeps the module's promise that
 * every failure is a `CanonicalJsonError` with a `reason`, preserving the
 * engine error as `cause`.
 *
 * Deliberately NOT a byte budget. A budget would be a 16th accepted-domain
 * rule with no consumer asking for it; this restores the error-type invariant
 * without narrowing what the module accepts. Add a budget when something
 * actually needs to fail early rather than late.
 */
export const canonicalJson = (value: CanonicalJsonValue): string => {
  try {
    return serialize(value, "$", 0, new Set());
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw error;
    }
    throw new CanonicalJsonError("serialization-failed", "$", error);
  }
};

/**
 * Hash a string as its exact UTF-8 bytes, or a `Uint8Array` byte-for-byte.
 *
 * The string overload validates its input against the same I-JSON string
 * domain `canonicalJson` enforces, because `TextEncoder.encode` is LOSSY on
 * strings this module otherwise rejects: it substitutes U+FFFD for every
 * unpaired surrogate, so all 2048 code units in U+D800–U+DFFF — and U+FFFD
 * itself — collapse onto ONE digest. Without this check the exported function
 * is not injective over its declared `string` type, which is a silent
 * pre-image collision in a primitive whose whole job is byte-exact evidence
 * digests.
 *
 * It is also the portability boundary. Python's `str.encode("utf-8")` raises
 * `UnicodeEncodeError` on a lone surrogate and Rust's `String` cannot hold one
 * at all, so the substituting behavior is reachable ONLY from JavaScript. A
 * digest no other language can reproduce is worse than a rejection every
 * language agrees on.
 *
 * The invariant this establishes: `sha256Hex` accepts exactly the strings
 * `canonicalJson` can emit. Arbitrary bytes are not second-class — they go
 * through the `Uint8Array` channel, which is byte-exact by construction and
 * is the correct escape hatch for anything outside the I-JSON string domain.
 *
 * `async` so the rejection surfaces as a rejected promise rather than a
 * synchronous throw, matching `hashCanonicalJson`.
 */
export const sha256Hex = async (bytes: string | Uint8Array): Promise<string> => {
  if (typeof bytes !== "string") {
    return protocolSha256Hex(bytes);
  }
  assertIjsonString(bytes, "$");
  return protocolSha256Hex(UTF8_ENCODER.encode(bytes));
};

export const hashCanonicalJson = async (value: CanonicalJsonValue): Promise<string> =>
  sha256Hex(canonicalJson(value));
