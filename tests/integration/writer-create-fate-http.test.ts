import { createBaerlyClient } from "@baerly/client";
import {
  BaerlyError,
  MemoryStorage,
  type StorageGetOptions,
  type StorageGetResult,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { Db } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

test.each(["exhausted-resends", "unreadable-occupant"] as const)(
  "HTTP and SDK preserve create fate after %s without duplicating an auto-ID insert",
  async (fault) => {
    class LostAckStorage extends MemoryStorage {
      faultEnabled = true;
      #committedKey: string | undefined;

      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (this.faultEnabled && key.includes("/log/") && opts?.ifNoneMatch === "*") {
          if (this.#committedKey === undefined) {
            await super.put(key, body, opts);
            this.#committedKey = key;
            throw new BaerlyError("NetworkError", "lost create acknowledgement");
          }
          if (fault === "exhausted-resends") {
            throw new BaerlyError("NetworkError", "resend unavailable");
          }
        }
        return super.put(key, body, opts);
      }

      override async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
        if (this.faultEnabled && fault === "unreadable-occupant" && key === this.#committedKey) {
          throw new BaerlyError("NetworkError", "readback unavailable");
        }
        return super.get(key, opts);
      }
    }

    // Eliminate retry backoff without controlling the UUIDv7 document IDs.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const storage = new LostAckStorage();
    const db = Db.create({ storage, app: "create-fate", tenant: "test" });
    const router = createRouter({ db });
    const statuses: number[] = [];
    const client = createBaerlyClient({
      baseUrl: "http://localhost",
      fetch: async (request) => {
        const response = await router.fetch(request);
        statuses.push(response.status);
        return response;
      },
    });
    let failure: unknown;
    try {
      await client.collection("tickets").insert({ title: "one logical insert" });
    } catch (error) {
      failure = error;
      storage.faultEnabled = false;
      // Model an application retry wrapper following the SDK error flag.
      if ((error as BaerlyError).retriable) {
        await client.collection("tickets").insert({ title: "one logical insert" });
      }
    }
    storage.faultEnabled = false;

    await expect(db.collection("tickets").where({}).all()).resolves.toHaveLength(1);
    expect(statuses).toEqual([fault === "exhausted-resends" ? 201 : 409]);
    if (fault === "unreadable-occupant") {
      expect(failure).toMatchObject({ code: "AmbiguousCommit", status: 409, retriable: false });
      expect((failure as BaerlyError).resolution).toBeTruthy();
      expect((failure as BaerlyError).message).not.toContain("manifests/");
    } else {
      expect(failure).toBeUndefined();
    }
  },
);
