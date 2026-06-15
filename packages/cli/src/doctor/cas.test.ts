import { MemoryStorage, type StoragePutOptions, type StoragePutResult } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { doctorCas } from "./cas.ts";

describe("doctorCas", () => {
  test("reports ok against a CAS-honouring backend", async () => {
    const report = await doctorCas(new MemoryStorage(), "");
    expect(report.status).toBe("ok");
    expect(report.findings.every((f) => f.severity === "ok")).toBe(true);
    expect(report.findings.map((f) => f.check).toSorted()).toEqual([
      "cas-ifMatch-stale",
      "cas-ifNoneMatch-concurrent",
      "cas-ifNoneMatch-exists",
    ]);
  });

  test("reports error + fix hint against a backend that ignores conditional writes", async () => {
    class NoCasStorage extends MemoryStorage {
      override async put(
        key: string,
        body: Uint8Array,
        _opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        return super.put(key, body);
      }
    }

    const report = await doctorCas(new NoCasStorage(), "");
    expect(report.status).toBe("error");
    const failed = report.findings.filter((f) => f.severity === "error");
    expect(failed.length).toBe(3);
    expect(failed.every((f) => typeof f.fix === "string" && f.fix.length > 0)).toBe(true);
  });
});
