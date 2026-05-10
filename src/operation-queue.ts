// Slated for deletion when the manifest poller is replaced (see
// .claude/research/00-plan.md Phase 2). The browser-direct offline
// tier this buffers for is being dropped; the file survives only
// because src/manifest.ts:33 still imports it. Do not extend.
import {
  type DeleteValue,
  type JSONValue,
  type Ref,
  type ResolvedRef,
  MPS3Error,
  OMap,
  url,
} from "@baerly/protocol";
import { type UseStore, getMany, get, set, delMany, keys } from "idb-keyval";

export type Operation = Promise<unknown>;

const PADDING = 6;

const entryKey = (index: number): string => `write-${index.toString().padStart(PADDING, "0")}`;

export class OperationQueue<L extends string> {
  private indexFor: WeakMap<Operation, number> = new WeakMap();
  proposedOperations: Map<Operation, [Map<ResolvedRef, JSONValue | DeleteValue>, number]> =
    new Map();
  operationLabels: Map<string, Operation> = new Map();
  private db?: UseStore;
  private lastIndex: number = 0;
  private load?: Promise<unknown> = undefined;
  private op: number = 0;
  private log: (...args: unknown[]) => void;
  constructor(store?: UseStore, log: (...args: unknown[]) => void = () => {}) {
    this.db = store;
    this.log = log;
  }

  async propose(
    write: Operation,
    values: Map<ResolvedRef, JSONValue | DeleteValue>,
    isLoad: boolean = false,
  ) {
    this.proposedOperations.set(write, [values, this.op++]);
    if (this.db) {
      if (this.load && !isLoad) {
        await this.load;
        // Get operations in the right order
        this.proposedOperations.delete(write);
        this.proposedOperations.set(write, [values, this.op - 1]);
      }
      this.lastIndex++;
      const key = entryKey(this.lastIndex);
      this.indexFor.set(write, this.lastIndex);
      await set(
        key,
        [...values.entries()].map(([ref, val]) => [JSON.stringify(ref), val]),
        this.db,
      );
    }
  }

  async label(write: Operation, label: L, isLoad: boolean = false) {
    this.operationLabels.set(label, write);

    if (this.db) {
      if (this.load && !isLoad) await this.load;
      const index = this.indexFor.get(write);

      if (index === undefined)
        throw new MPS3Error("Internal", "Cannot label an unproposed operation");
      const key = `label-${index}`;
      await set(key, label, this.db);
    }
  }

  async confirm(label: L, isLoad: boolean = false) {
    if (this.operationLabels.has(label)) {
      const operation = this.operationLabels.get(label)!;
      this.proposedOperations.delete(operation);
      this.operationLabels.delete(label);
      if (this.db) {
        if (this.load && !isLoad) await this.load;
        const index = this.indexFor.get(operation);
        if (index === undefined)
          throw new MPS3Error("Internal", "Cannot confirm an unproposed operation");
        const keysToDelete = [entryKey(index), `label-${index}`];
        await delMany(keysToDelete, this.db);
      }
    }
  }

  async cancel(operation: Operation, isLoad: boolean = false) {
    this.operationLabels.forEach((value, key) => {
      if (value === operation) {
        this.operationLabels.delete(key);
      }
    });
    this.proposedOperations.delete(operation);
    if (this.db) {
      if (this.load && !isLoad) await this.load;
      const index = this.indexFor.get(operation);
      if (index === undefined) return;
      await delMany([entryKey(index), `label-${index}`], this.db);
    }
  }

  async flatten(): Promise<OMap<ResolvedRef, [JSONValue | DeleteValue, number]>> {
    if (this.load) await this.load;
    const mask = new OMap<ResolvedRef, [JSONValue | DeleteValue, number]>(url);
    this.proposedOperations.forEach(([values, op]) => {
      values.forEach((value, ref) => {
        mask.set(ref, [value, op]);
      });
    });
    return mask;
  }

  async restore(
    store: UseStore,
    schedule: (write: Map<ResolvedRef, JSONValue | DeleteValue>, label?: L) => Promise<unknown>,
  ) {
    this.db = store;
    this.proposedOperations.clear();
    this.operationLabels.clear();
    this.lastIndex = 0;
    this.load = (async () => {
      const allKeys: string[] = await keys(this.db);
      const entryKeys = allKeys.filter((key: any) => key.startsWith("write-")).sort();
      const entryValues = await getMany(entryKeys, this.db);

      for (let i = 0; i < entryKeys.length; i++) {
        const index = parseInt(entryKeys[i]!.split("-")[1]!);
        this.lastIndex = Math.max(this.lastIndex, index);
      }

      for (let i = 0; i < entryKeys.length; i++) {
        const key = entryKeys[i]!;
        const index = parseInt(key.split("-")[1]!);
        try {
          const entry = entryValues[i].map(([ref, val]: [string, JSONValue | DeleteValue]) => {
            const parsed: unknown = JSON.parse(ref);
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              typeof (parsed as Ref).bucket !== "string" ||
              typeof (parsed as Ref).key !== "string"
            ) {
              throw new MPS3Error("Internal", `corrupt operation-queue ref: ${ref}`);
            }
            return [parsed as ResolvedRef, val];
          });
          const label = await get<L>(`label-${index}`, this.db);
          if (!entry) continue;
          const values = new Map<ResolvedRef, JSONValue | DeleteValue>(entry);
          await schedule(values, label);
          // delete entries after confirmation
          await delMany([entryKey(index), `label-${index}`], this.db);
        } catch (err) {
          this.log(`RESTORE_FAILED ${key}`, err);
        }
      }
    })();
    return this.load;
  }
}
