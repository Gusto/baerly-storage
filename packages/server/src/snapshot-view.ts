import { BaerlyError, type DocumentData, type Storage } from "@baerly/protocol";
import { decodeSnapshotChunk } from "./snapshot-chunk.ts";
import { assertSnapshotDocId, compareDocIds } from "./snapshot-doc-id.ts";
import { decodeSnapshotManifest, type SnapshotChunkDescriptor } from "./snapshot-manifest.ts";

export interface SnapshotRow {
  readonly _id: string;
  readonly body: DocumentData;
}

export interface SnapshotView {
  get(docId: string, signal?: AbortSignal): Promise<DocumentData | undefined>;
  scan(
    range?: { readonly gte?: string; readonly lt?: string },
    signal?: AbortSignal,
  ): AsyncIterable<SnapshotRow>;
  materialize(signal?: AbortSignal): Promise<Map<string, DocumentData>>;
}

export interface OpenSnapshotViewInput {
  readonly storage: Storage;
  readonly manifestKey: string | null;
  readonly collection: string;
  readonly expectedLogSeqStart: number;
  readonly signal?: AbortSignal;
}

function missingArtifact(kind: "manifest" | "chunk", key: string): never {
  throw new BaerlyError("InvalidResponse", `snapshot view: referenced ${kind} is missing: ${key}`);
}

function firstDescriptorEndingAtOrAfter(
  descriptors: readonly SnapshotChunkDescriptor[],
  id: string,
): number {
  let low = 0;
  let high = descriptors.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compareDocIds(descriptors[middle]!.last_id, id) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function findDocument(docs: readonly DocumentData[], id: string): DocumentData | undefined {
  let low = 0;
  let high = docs.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = docs[middle]!;
    const comparison = compareDocIds(candidate["_id"] as string, id);
    if (comparison < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const candidate = docs[low];
  return candidate !== undefined && compareDocIds(candidate["_id"] as string, id) === 0
    ? candidate
    : undefined;
}

export const openSnapshotView = async (input: OpenSnapshotViewInput): Promise<SnapshotView> => {
  input.signal?.throwIfAborted();
  const manifest =
    input.manifestKey === null
      ? null
      : await (async () => {
          const stored = await input.storage.get(input.manifestKey!, { signal: input.signal });
          if (stored === null) {
            missingArtifact("manifest", input.manifestKey!);
          }
          return decodeSnapshotManifest(
            stored.body,
            input.manifestKey!,
            input.collection,
            input.expectedLogSeqStart,
          );
        })();
  const descriptors = manifest?.chunks ?? [];

  const loadChunk = async (
    descriptor: SnapshotChunkDescriptor,
    signal?: AbortSignal,
  ): Promise<readonly DocumentData[]> => {
    signal?.throwIfAborted();
    const stored = await input.storage.get(descriptor.key, { signal });
    if (stored === null) {
      missingArtifact("chunk", descriptor.key);
    }
    const chunk = await decodeSnapshotChunk(
      stored.body,
      descriptor.key,
      input.collection,
      descriptor,
    );
    return chunk.docs;
  };

  const view: SnapshotView = {
    async get(docId, signal) {
      assertSnapshotDocId(docId);
      signal?.throwIfAborted();
      const descriptorIndex = firstDescriptorEndingAtOrAfter(descriptors, docId);
      const descriptor = descriptors[descriptorIndex];
      if (descriptor === undefined || compareDocIds(descriptor.first_id, docId) > 0) {
        return undefined;
      }
      return findDocument(await loadChunk(descriptor, signal), docId);
    },

    async *scan(range, signal) {
      if (range?.gte !== undefined) {
        assertSnapshotDocId(range.gte);
      }
      if (range?.lt !== undefined) {
        assertSnapshotDocId(range.lt);
      }
      signal?.throwIfAborted();
      if (
        range?.gte !== undefined &&
        range.lt !== undefined &&
        compareDocIds(range.gte, range.lt) >= 0
      ) {
        return;
      }

      let descriptorIndex =
        range?.gte === undefined ? 0 : firstDescriptorEndingAtOrAfter(descriptors, range.gte);
      while (descriptorIndex < descriptors.length) {
        const descriptor = descriptors[descriptorIndex]!;
        if (range?.lt !== undefined && compareDocIds(descriptor.first_id, range.lt) >= 0) {
          return;
        }
        const docs = await loadChunk(descriptor, signal);
        for (const body of docs) {
          const id = body["_id"] as string;
          if (range?.gte !== undefined && compareDocIds(id, range.gte) < 0) {
            continue;
          }
          if (range?.lt !== undefined && compareDocIds(id, range.lt) >= 0) {
            break;
          }
          yield { _id: id, body };
        }
        descriptorIndex++;
      }
    },

    async materialize(signal) {
      const documents = new Map<string, DocumentData>();
      for await (const { _id, body } of view.scan(undefined, signal)) {
        documents.set(_id, body);
      }
      return documents;
    },
  };
  return view;
};
