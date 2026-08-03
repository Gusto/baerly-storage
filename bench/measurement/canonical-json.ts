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
  | "non-plain-object"
  | "cyclic-reference"
  | "array-hole"
  | "array-extra-property"
  | "symbol-key"
  | "forbidden-key"
  | "non-enumerable-own-property"
  | "accessor-own-property"
  | "max-depth-exceeded";

export class CanonicalJsonError extends Error {
  readonly code = "CanonicalJsonError" as const;
  readonly reason: CanonicalJsonRejectionReason;
  readonly path: string;

  constructor(reason: CanonicalJsonRejectionReason, path: string) {
    super(`Canonical JSON rejected ${reason} at ${path}`);
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

  const properties: OwnDataProperty[] = [];
  for (const ownKey of keys) {
    if (typeof ownKey !== "string" || (arrayLength !== undefined && ownKey === "length")) {
      continue;
    }

    const childPath =
      arrayLength !== undefined && isArrayIndex(ownKey, arrayLength)
        ? `${path}[${ownKey}]`
        : propertyPath(path, ownKey);
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

  const properties = ownDataProperties(value, path).toSorted((left, right) =>
    compareUtf16(left.key, right.key),
  );
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

export const canonicalJson = (value: CanonicalJsonValue): string =>
  serialize(value, "$", 0, new Set());

export const sha256Hex = (bytes: string | Uint8Array): Promise<string> =>
  protocolSha256Hex(typeof bytes === "string" ? UTF8_ENCODER.encode(bytes) : bytes);

export const hashCanonicalJson = async (value: CanonicalJsonValue): Promise<string> =>
  sha256Hex(canonicalJson(value));
