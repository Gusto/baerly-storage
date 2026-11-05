import {
  BaerlyError,
  createCurrentJson,
  type LogEntry,
  MemoryStorage,
  type StorageGetOptions,
  type StorageGetResult,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { Db } from "./db.ts";
import {
  createObservabilityContext,
  type ObservabilityContext,
  runWithContext,
} from "./observability/context.ts";
import { Writer } from "./writer.ts";

const CURRENT_KEY = "app/test/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/test/tenant/t/manifests/tickets/log/";
const isLogCreate = (key: string, opts?: StoragePutOptions): boolean =>
  key.startsWith(LOG_PREFIX) && opts?.ifNoneMatch === "*";

type Fault = "lost-ack" | "unreadable-readback" | "malformed-readback" | "missing-readback";

/**
 * Faults begin only after a conditional log create is dispatched. The first
 * create at the slot fails with a `NetworkError` (landed, except under
 * `missing-readback`); any further create at that slot also fails, so a
 * Writer-level same-slot resend shows up in `attempts` and never helps.
 */
class CreateFateStorage extends MemoryStorage {
  faultEnabled = true;
  readonly attempts: string[] = [];
  readonly fault: Fault;
  #slot: string | undefined;
  #delayedCreate: (() => Promise<StoragePutResult>) | undefined;

  constructor(fault: Fault) {
    super();
    this.fault = fault;
  }

  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    if (!this.faultEnabled || !isLogCreate(key, opts)) {
      return super.put(key, body, opts);
    }
    this.attempts.push(key);
    if (this.#slot === undefined) {
      this.#slot = key;
      // The missing case models an unresolved in-flight send: an absent
      // readback cannot prove that its create will never complete.
      if (this.fault !== "missing-readback") {
        await super.put(key, body, opts);
      } else {
        const retainedBody = body.slice();
        this.#delayedCreate = () => super.put(key, retainedBody, opts);
      }
      throw new BaerlyError("NetworkError", "lost create acknowledgement");
    }
    throw new BaerlyError("NetworkError", "resend transport unavailable");
  }

  override async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    if (this.faultEnabled && key === this.#slot) {
      if (this.fault === "unreadable-readback") {
        throw new BaerlyError("NetworkError", "occupant read unavailable");
      }
      if (this.fault === "malformed-readback") {
        const existing = await super.get(key, opts);
        if (existing !== null) {
          return { ...existing, body: new TextEncoder().encode("{broken-json") };
        }
      }
    }
    return super.get(key, opts);
  }

  async completeDelayedCreate(): Promise<void> {
    if (this.#delayedCreate === undefined) {
      throw new Error("no delayed create was dispatched");
    }
    await this.#delayedCreate();
  }
}

const makeWriter = (storage: MemoryStorage): Writer =>
  new Writer({
    storage,
    currentJsonKey: CURRENT_KEY,
  });

const insert = (writer: Writer) =>
  writer.commit({ op: "I", collection: "tickets", docId: "one", body: { _id: "one" } });

const sumCounter = (ctx: ObservabilityContext, name: string): number =>
  ctx.recorder
    .snapshot()
    .counters.filter((c) => c.name === name)
    .reduce((acc, c) => acc + c.value, 0);

describe("Writer create fate", () => {
  afterEach(() => vi.restoreAllMocks());

  test("a lost ack is adopted by one readback, with no same-slot resend", async () => {
    const storage = new CreateFateStorage("lost-ack");
    await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());

    await expect(insert(makeWriter(storage))).resolves.toMatchObject({
      entry: { seq: 0, doc_id: "one" },
    });
    expect(storage.attempts).toEqual([`${LOG_PREFIX}0.json`]);
    storage.faultEnabled = false;
    await expect(
      Db.create({ storage, app: "test", tenant: "t" }).collection("tickets").count(),
    ).resolves.toBe(1);
  });

  test.each(["unreadable-readback", "malformed-readback", "missing-readback"] as const)(
    "%s after a possibly durable create is non-retriable ambiguity, with no same-slot resend",
    async (fault) => {
      const storage = new CreateFateStorage(fault);
      await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());

      const failure: unknown = await insert(makeWriter(storage)).catch((error: unknown) => error);
      if (fault === "missing-readback") {
        // Complete the original dispatch after the call has already failed.
        // A null readback must not permit a safe-to-retry classification.
        await expect(storage.get(`${LOG_PREFIX}0.json`)).resolves.toBeNull();
        await storage.completeDelayedCreate();
      }
      storage.faultEnabled = false;
      await expect(
        Db.create({ storage, app: "test", tenant: "t" }).collection("tickets").count(),
      ).resolves.toBe(1);
      expect(failure).toMatchObject({
        code: "AmbiguousCommit",
        _id: "one",
        retriable: false,
      });
      expect(storage.attempts).toEqual([`${LOG_PREFIX}0.json`]);
    },
  );

  test.each(["unavailable", "malformed"] as const)(
    "an initial visible 412 with %s readback cannot exclude hidden adapter sends",
    async (failure) => {
      class ForeignConflictStorage extends MemoryStorage {
        #conflicted = false;

        override async put(
          key: string,
          body: Uint8Array,
          opts?: StoragePutOptions,
        ): Promise<StoragePutResult> {
          if (isLogCreate(key, opts)) {
            this.#conflicted = true;
            throw new BaerlyError("WriteConflict", "412 precondition failed");
          }
          return super.put(key, body, opts);
        }

        override async get(
          key: string,
          opts?: StorageGetOptions,
        ): Promise<StorageGetResult | null> {
          if (this.#conflicted && key.startsWith(LOG_PREFIX)) {
            if (failure === "unavailable") {
              throw new BaerlyError("NetworkError", "foreign occupant read unavailable");
            }
            return { body: new TextEncoder().encode("{broken-json"), etag: "foreign" };
          }
          return super.get(key, opts);
        }
      }
      const storage = new ForeignConflictStorage();
      await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());
      await expect(insert(makeWriter(storage))).rejects.toMatchObject({
        code: "AmbiguousCommit",
        _id: "one",
        retriable: false,
      });
    },
  );

  test.each(["success", "denied"] as const)(
    "a foreign readback after an uncertain send does not adopt or duplicate the entry; the next slot's %s is reported as-is",
    async (nextSlot) => {
      class ForeignFinalReadbackStorage extends MemoryStorage {
        readonly attempts: string[] = [];

        override async put(
          key: string,
          body: Uint8Array,
          opts?: StoragePutOptions,
        ): Promise<StoragePutResult> {
          if (!isLogCreate(key, opts)) {
            return super.put(key, body, opts);
          }
          this.attempts.push(key);
          if (key === `${LOG_PREFIX}0.json`) {
            if (this.attempts.length === 1) {
              const foreign = JSON.parse(new TextDecoder().decode(body)) as LogEntry;
              await super.put(
                key,
                new TextEncoder().encode(
                  JSON.stringify({
                    ...foreign,
                    session: "INTRUDR0",
                    doc_id: "foreign",
                    after: { _id: "foreign" },
                  }),
                ),
                opts,
              );
            }
            throw new BaerlyError("NetworkError", "uncertain send into foreign slot");
          }
          if (nextSlot === "denied") {
            throw new BaerlyError("AccessDenied", "fresh send rejected");
          }
          return super.put(key, body, opts);
        }
      }
      const storage = new ForeignFinalReadbackStorage();
      await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());
      const action = insert(makeWriter(storage));
      if (nextSlot === "success") {
        await expect(action).resolves.toMatchObject({ entry: { seq: 1, doc_id: "one" } });
      } else {
        // Our only send at seq 1 was definitively rejected and the send at
        // seq 0 resolved to the foreign occupant, so nothing of ours landed.
        await expect(action).rejects.toMatchObject({ code: "AccessDenied" });
      }
      // One send per slot: seq 0 resolves by readback, seq 1 is a new slot.
      expect(storage.attempts).toEqual([`${LOG_PREFIX}0.json`, `${LOG_PREFIX}1.json`]);
    },
  );

  test.each(["AccessDenied", "InvalidConfig"] as const)(
    "an initial %s with no uncertain send at the slot propagates without resend or readback",
    async (code) => {
      class DeniedCreateStorage extends MemoryStorage {
        readonly attempts: string[] = [];
        slotReads = 0;

        override async put(
          key: string,
          body: Uint8Array,
          opts?: StoragePutOptions,
        ): Promise<StoragePutResult> {
          if (isLogCreate(key, opts)) {
            this.attempts.push(key);
            throw new BaerlyError(code, "create rejected");
          }
          return super.put(key, body, opts);
        }

        override async get(
          key: string,
          opts?: StorageGetOptions,
        ): Promise<StorageGetResult | null> {
          if (key.startsWith(LOG_PREFIX)) {
            this.slotReads++;
          }
          return super.get(key, opts);
        }
      }
      const storage = new DeniedCreateStorage();
      await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());
      const readsBeforeCreate = storage.slotReads;
      // The `Storage.put` contract makes this code definitive: no attempt of
      // the call can land, so the caller sees the real misconfiguration.
      await expect(insert(makeWriter(storage))).rejects.toMatchObject({ code });
      expect(storage.attempts).toEqual([`${LOG_PREFIX}0.json`]);
      expect(storage.slotReads - readsBeforeCreate).toBe(1);
    },
  );

  test("a create refused unapplied propagates its retriable NetworkError with no resend or readback", async () => {
    class ThrottledCreateStorage extends MemoryStorage {
      readonly attempts: string[] = [];
      slotReads = 0;

      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (isLogCreate(key, opts)) {
          this.attempts.push(key);
          throw new BaerlyError("NetworkError", "throttled", {
            cause: { status: 429, notApplied: true },
          });
        }
        return super.put(key, body, opts);
      }

      override async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
        if (key.startsWith(LOG_PREFIX)) {
          this.slotReads++;
        }
        return super.get(key, opts);
      }
    }
    const storage = new ThrottledCreateStorage();
    await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());
    const readsBeforeCreate = storage.slotReads;
    const ctx = createObservabilityContext();
    const outcome = runWithContext(ctx, () => insert(makeWriter(storage)));

    // Nothing of ours can be at the slot, so the retriable error stands.
    await expect(outcome).rejects.toMatchObject({
      code: "NetworkError",
      retriable: true,
      cause: { notApplied: true },
    });
    // The one log read is the tail probe; there is no occupant readback.
    expect(storage.slotReads - readsBeforeCreate).toBe(1);
    expect(sumCounter(ctx, "db.write.unresolved_create_total")).toBe(0);
    expect(storage.attempts).toEqual([`${LOG_PREFIX}0.json`]);
  });

  test.each(["bigint", "circular"] as const)(
    "a %s body that cannot be encoded surfaces its own error with no create, readback, or unresolved count",
    async (shape) => {
      class CountingStorage extends MemoryStorage {
        readonly attempts: string[] = [];
        slotReads = 0;

        override async put(
          key: string,
          body: Uint8Array,
          opts?: StoragePutOptions,
        ): Promise<StoragePutResult> {
          if (isLogCreate(key, opts)) {
            this.attempts.push(key);
          }
          return super.put(key, body, opts);
        }

        override async get(
          key: string,
          opts?: StorageGetOptions,
        ): Promise<StorageGetResult | null> {
          if (key.startsWith(LOG_PREFIX)) {
            this.slotReads++;
          }
          return super.get(key, opts);
        }
      }
      const storage = new CountingStorage();
      await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());
      const readsBeforeCreate = storage.slotReads;
      const body: Record<string, unknown> = { _id: "one" };
      if (shape === "bigint") {
        body["n"] = 1n;
      } else {
        body["self"] = body;
      }
      const ctx = createObservabilityContext({ maintenance: { disabled: true } });
      let failure: unknown;
      try {
        await runWithContext(ctx, () =>
          makeWriter(storage).commit({
            op: "I",
            collection: "tickets",
            docId: "one",
            body: body as never,
          }),
        );
      } catch (error) {
        failure = error;
      }

      // The encode failure is the caller's error, not an uncertain send.
      expect(failure).toBeInstanceOf(TypeError);
      expect(storage.attempts).toEqual([]);
      // The one log read is the tail probe; there is no occupant readback.
      expect(storage.slotReads - readsBeforeCreate).toBe(1);
      expect(sumCounter(ctx, "db.write.unresolved_create_total")).toBe(0);
    },
  );

  test("a create failing with a non-BaerlyError is uncertain and resolves by readback", async () => {
    class PlainErrorLostAckStorage extends MemoryStorage {
      readonly attempts: string[] = [];
      slotReadbacks = 0;
      #created = false;

      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (!isLogCreate(key, opts)) {
          return super.put(key, body, opts);
        }
        this.attempts.push(key);
        // A raw runtime error after the object landed: nothing in it
        // proves the create was not applied.
        await super.put(key, body, opts);
        this.#created = true;
        throw new Error("socket hang up");
      }

      override async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
        if (this.#created && key === `${LOG_PREFIX}0.json`) {
          this.slotReadbacks++;
        }
        return super.get(key, opts);
      }
    }
    const storage = new PlainErrorLostAckStorage();
    await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());

    await expect(insert(makeWriter(storage))).resolves.toMatchObject({
      entry: { seq: 0, doc_id: "one" },
    });
    expect(storage.slotReadbacks).toBe(1);
    expect(storage.attempts).toEqual([`${LOG_PREFIX}0.json`]);
  });

  test("a failed readback is not re-read by the Writer; the fate is ambiguous", async () => {
    class HiddenRetryFlakyReadStorage extends MemoryStorage {
      readonly attempts: string[] = [];
      failedReads = 0;
      slotReadbacks = 0;
      #created = false;

      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (!isLogCreate(key, opts)) {
          return super.put(key, body, opts);
        }
        this.attempts.push(key);
        // Models an adapter whose hidden first attempt landed and whose
        // internal retry saw the durable object as a 412.
        await super.put(key, body, opts);
        this.#created = true;
        throw new BaerlyError("WriteConflict", "412 precondition failed");
      }

      override async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
        if (this.#created && key === `${LOG_PREFIX}0.json`) {
          this.slotReadbacks++;
          if (this.failedReads === 0) {
            this.failedReads++;
            throw new BaerlyError("NetworkError", "occupant read blipped");
          }
        }
        return super.get(key, opts);
      }
    }
    const storage = new HiddenRetryFlakyReadStorage();
    await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());

    // The adapter owns retries of the readback GET, so one failed
    // `Storage.get` leaves the fate unresolved even though our entry is
    // durable.
    await expect(insert(makeWriter(storage))).rejects.toMatchObject({
      code: "AmbiguousCommit",
      _id: "one",
      retriable: false,
    });
    expect(storage.failedReads).toBe(1);
    expect(storage.slotReadbacks).toBe(1);
    expect(storage.attempts).toEqual([`${LOG_PREFIX}0.json`]);
  });

  test("an unresolved create is counted on db.write.unresolved_create_total", async () => {
    const storage = new CreateFateStorage("unreadable-readback");
    await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());
    const ctx = createObservabilityContext({ maintenance: { disabled: true } });

    await expect(runWithContext(ctx, () => insert(makeWriter(storage)))).rejects.toMatchObject({
      code: "AmbiguousCommit",
      _id: "one",
    });
    expect(sumCounter(ctx, "db.write.unresolved_create_total")).toBe(1);
  });

  test.each(["lost-ack", "unreadable-readback"] as const)(
    "public auto-ID insert does not duplicate under an automatic retry after %s",
    async (fault) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const storage = new CreateFateStorage(fault);
      await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());
      const collection = Db.create({ storage, app: "test", tenant: "t" }).collection("tickets");
      let failure: unknown;
      try {
        await collection.insert({ title: "one logical insert" });
      } catch (error) {
        failure = error;
        storage.faultEnabled = false;
        // A caller following the SDK's retriable flag must not duplicate
        // the auto-ID document whose first create is already durable.
        if ((error as BaerlyError).retriable) {
          await collection.insert({ title: "one logical insert" });
        }
      }
      storage.faultEnabled = false;
      await expect(collection.where({}).all()).resolves.toHaveLength(1);
      if (fault === "unreadable-readback") {
        expect(failure).toMatchObject({ code: "AmbiguousCommit", retriable: false });
        // The minted id names the row that landed.
        const [row] = await collection.where({}).all();
        expect((failure as BaerlyError)._id).toBe(row!["_id"]);
      } else {
        expect(failure).toBeUndefined();
      }
    },
  );

  test.each(
    [null, {}, [], 0, "foreign", { session: "INTRUDR0" }].map((occupant) => ({ occupant })),
  )(
    "structurally malformed JSON %j cannot resolve a possibly durable send as foreign",
    async ({ occupant }) => {
      class MalformedJsonOccupantStorage extends CreateFateStorage {
        override async get(
          key: string,
          opts?: StorageGetOptions,
        ): Promise<StorageGetResult | null> {
          if (this.faultEnabled && this.attempts.length > 0 && key === `${LOG_PREFIX}0.json`) {
            return { body: new TextEncoder().encode(JSON.stringify(occupant)), etag: "malformed" };
          }
          return super.get(key, opts);
        }
      }
      const storage = new MalformedJsonOccupantStorage("lost-ack");
      await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());
      const failure: unknown = await insert(makeWriter(storage)).catch((error: unknown) => error);
      storage.faultEnabled = false;
      await expect(
        Db.create({ storage, app: "test", tenant: "t" }).collection("tickets").count(),
      ).resolves.toBe(1);
      expect(failure).toMatchObject({ code: "AmbiguousCommit", _id: "one", retriable: false });
      expect(storage.attempts).toEqual([`${LOG_PREFIX}0.json`]);
    },
  );

  test("an uncertain send into a foreign slot forward-probes; the next slot's lost ack resolves by readback", async () => {
    class ForeignThenOwnLostAckStorage extends MemoryStorage {
      readonly attempts = new Map<string, number>();

      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (!isLogCreate(key, opts)) {
          return super.put(key, body, opts);
        }
        const attempt = (this.attempts.get(key) ?? 0) + 1;
        this.attempts.set(key, attempt);
        if (attempt === 1) {
          if (key === `${LOG_PREFIX}0.json`) {
            const foreign = JSON.parse(new TextDecoder().decode(body)) as LogEntry;
            await super.put(
              key,
              new TextEncoder().encode(JSON.stringify({ ...foreign, session: "INTRUDR0" })),
              opts,
            );
          } else {
            await super.put(key, body, opts);
          }
          throw new BaerlyError("NetworkError", "lost create acknowledgement");
        }
        return super.put(key, body, opts);
      }
    }
    const storage = new ForeignThenOwnLostAckStorage();
    await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());

    await expect(insert(makeWriter(storage))).resolves.toMatchObject({
      entry: { seq: 1, doc_id: "one" },
    });
    expect(storage.attempts).toEqual(
      new Map([
        // One send per slot: each uncertain send resolves by readback.
        [`${LOG_PREFIX}0.json`, 1],
        [`${LOG_PREFIX}1.json`, 1],
      ]),
    );
  });
});
