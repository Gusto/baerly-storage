import { BaerlyError, type DocumentData, type DocumentValue } from "@baerly/protocol";
import { assertCodecDocId, normalizeCodecFailure } from "./snapshot-codec.ts";
import { compareDocIds } from "./snapshot-doc-id.ts";

export interface ReferenceRow {
  readonly _id: string;
  readonly body: DocumentData;
}

export type ReferenceMutation =
  | {
      readonly op: "I" | "U";
      readonly doc_id: string;
      readonly after: DocumentData;
    }
  | { readonly op: "D"; readonly doc_id: string };

export type ReferenceFold = (
  rows: readonly ReferenceRow[],
  mutations: readonly ReferenceMutation[],
) => readonly ReferenceRow[];

function invalid(
  code: "InvalidConfig" | "InvalidResponse",
  message: string,
  cause?: unknown,
): never {
  throw new BaerlyError(code, `chunked snapshot reference: ${message}`, cause);
}

function assertDocumentValue(value: unknown, where: string, ancestors: Set<object>): void {
  if (typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalid("InvalidResponse", `${where} must contain only finite numbers`);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    invalid("InvalidResponse", `${where} contains a value outside DocumentData`);
  }
  if (ancestors.has(value)) {
    invalid("InvalidResponse", `${where} contains a cycle`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        invalid("InvalidResponse", `${where} contains a sparse array`);
      }
      assertDocumentValue(value[index], `${where}[${index}]`, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid("InvalidResponse", `${where} must contain only plain objects`);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      invalid("InvalidResponse", `${where} must not contain symbol keys`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        invalid("InvalidResponse", `${where}.${key} must be an enumerable data property`);
      }
      assertDocumentValue(descriptor.value, `${where}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertDocument(value: unknown, id: string, where: string): asserts value is DocumentData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("InvalidResponse", `${where} must be a document object`);
  }
  assertDocumentValue(value, where, new Set<object>());
  const storedId = Object.getOwnPropertyDescriptor(value, "_id")?.value;
  assertCodecDocId(storedId, `${where}._id`, "InvalidResponse", invalid);
  if (storedId !== id) {
    invalid(
      "InvalidResponse",
      `${where}._id must equal ${where === "row.body" ? "row._id" : "mutation.doc_id"}`,
    );
  }
}

function assertObject(value: unknown, where: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("InvalidResponse", `${where} must be an object`);
  }
}

function cloneAndFreezeValue(value: DocumentValue): DocumentValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezeValue)) as unknown as DocumentValue;
  }
  const cloned: DocumentData = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    Object.defineProperty(cloned, key, {
      value: cloneAndFreezeValue(descriptor.value as DocumentValue),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(cloned) as DocumentData;
}

const cloneAndFreezeDocument = (document: DocumentData): DocumentData =>
  cloneAndFreezeValue(document) as DocumentData;

export const foldChunkedSnapshotReference: ReferenceFold = (rows, mutations) =>
  normalizeCodecFailure(
    invalid,
    "InvalidResponse",
    "rows or mutations exceed supported validation depth",
    () => {
      if (!Array.isArray(rows)) {
        invalid("InvalidResponse", "rows must be an array");
      }
      if (!Array.isArray(mutations)) {
        invalid("InvalidResponse", "mutations must be an array");
      }

      const documents = new Map<string, DocumentData>();
      for (const candidate of rows as readonly unknown[]) {
        assertObject(candidate, "row");
        assertCodecDocId(candidate["_id"], "row._id", "InvalidResponse", invalid);
        const id = candidate["_id"];
        assertDocument(candidate["body"], id, "row.body");
        if (documents.has(id)) {
          invalid("InvalidResponse", "rows contain a duplicate _id");
        }
        documents.set(id, cloneAndFreezeDocument(candidate["body"]));
      }

      for (const candidate of mutations as readonly unknown[]) {
        assertObject(candidate, "mutation");
        const op = candidate["op"];
        if (op !== "I" && op !== "U" && op !== "D") {
          invalid("InvalidResponse", "mutation.op must be I, U, or D");
        }
        assertCodecDocId(candidate["doc_id"], "mutation.doc_id", "InvalidResponse", invalid);
        const id = candidate["doc_id"];
        if (op === "D") {
          documents.delete(id);
        } else {
          assertDocument(candidate["after"], id, "mutation.after");
          documents.set(id, cloneAndFreezeDocument(candidate["after"]));
        }
      }

      return Object.freeze(
        [...documents]
          .map(([_id, body]) => Object.freeze({ _id, body }))
          .toSorted((left, right) => compareDocIds(left._id, right._id)),
      );
    },
  );
