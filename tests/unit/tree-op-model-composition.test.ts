import { describe, expect, test } from "vitest";
import { GC_MARK_LIST_PAGE_KEYS } from "@baerly/protocol";
import {
  chargedByKind,
  composedTickCalls,
  measureTickOverhead,
} from "../../bench/tree-op-model/measure.ts";
import {
  ALL_ATTEMPTS,
  chargedRequests,
  DEFAULT_ASSUMPTIONS,
  foldTickCalls,
  GC_WORST_STATE,
  gcTickCalls,
  HAPPY_PATH,
} from "../../bench/tree-op-model/model.ts";

describe("tree tick composed overhead", () => {
  test.each([
    ["happy", HAPPY_PATH],
    ["all-attempts", ALL_ATTEMPTS],
  ] as const)("matches the runner read and actual hint refresh: %s", async (mode, policy) => {
    const measured = await measureTickOverhead(mode);
    expect(chargedByKind(composedTickCalls(), policy)).toEqual(measured.attempts);

    const common = {
      shape: { depth: 0, fanout: 1, leaves: 1 },
      assumptions: DEFAULT_ASSUMPTIONS,
    };
    const fold = (headCasLost: boolean) =>
      chargedRequests(
        foldTickCalls({
          ...common,
          changedLeaves: 1,
          sharing: "distinct",
          entriesFolded: 1,
          emptyBase: false,
          concurrentCommits: 0,
          headCasLost,
        }),
        policy,
      );
    // A lost fold adds the fate GET and refresh: the same call kinds as
    // the measured runner GET and refresh.
    expect(fold(true) - fold(false)).toBe(measured.ledgerCharged);

    const gc = (tailHintRefresh: boolean) =>
      chargedRequests(
        gcTickCalls({
          ...common,
          sweeps: 0,
          retirementDeletes: 0,
          listPageKeys: GC_MARK_LIST_PAGE_KEYS,
          state: { ...GC_WORST_STATE, tailHintRefresh },
        }),
        policy,
      );
    expect(gc(true) - gc(false)).toBe(measured.ledgerCharged - policy.attemptsPerCall);
  });
});
