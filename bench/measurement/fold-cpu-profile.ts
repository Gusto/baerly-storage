import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import type { Profiler } from "node:inspector";
import { join } from "node:path";
import type { FoldCpuCell, FoldCpuOperation, RuntimeArm } from "./fold-cpu.ts";

export const PROFILE_INTERVAL_US = 1000;

export interface InvocationProfiler {
  start(): Promise<void>;
  stop(): Promise<void>;
  save?(): Promise<void>;
}

export interface ProfileIdentity {
  cell: FoldCpuCell;
  operation: FoldCpuOperation;
  runtime_arm: RuntimeArm;
  repetition: number;
  snapshot_bytes: number;
}

/** Sample-weighted stacks, not wall-time attribution or off-thread CPU. */
export const summarizeProfile = (profile: Profiler.Profile) => {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      parents.set(child, node.id);
    }
  }
  const frames = new Map<
    string,
    {
      function: string;
      url: string;
      line: number;
      column: number;
      self_us: number;
      inclusive_us: number;
    }
  >();
  let sampledUs = 0;
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const weight = profile.timeDeltas?.[index] ?? 0;
    sampledUs += weight;
    const seenFrames = new Set<string>();
    const seenNodes = new Set<number>();
    let current: number | undefined = id;
    while (current !== undefined && !seenNodes.has(current)) {
      seenNodes.add(current);
      const node = nodes.get(current);
      if (!node) {
        throw new Error(`profile sample references unknown node ${current}`);
      }
      const frame = node.callFrame;
      const key = JSON.stringify([
        frame.functionName,
        frame.url,
        frame.lineNumber,
        frame.columnNumber,
      ]);
      const totals = frames.get(key) ?? {
        function: frame.functionName || "(anonymous)",
        url: frame.url,
        line: frame.lineNumber + 1,
        column: frame.columnNumber + 1,
        self_us: 0,
        inclusive_us: 0,
      };
      if (current === id) {
        totals.self_us += weight;
      }
      // Count a recursive frame once per sampled stack.
      if (!seenFrames.has(key)) {
        totals.inclusive_us += weight;
        seenFrames.add(key);
      }
      frames.set(key, totals);
      current = parents.get(current);
    }
  }
  return {
    samples: profile.samples?.length ?? 0,
    sampled_us: sampledUs,
    duration_us: profile.endTime - profile.startTime,
    frames: [...frames.values()].toSorted((a, b) => b.self_us - a.self_us),
  };
};

export interface ProfileEntry extends ProfileIdentity {
  file: string;
  sha256: string;
  summary: ReturnType<typeof summarizeProfile>;
}

/** One inspector connection per invocation; never active during fixture construction. */
export const createInvocationProfile = (
  directory: string,
  identity: ProfileIdentity,
  entries: ProfileEntry[],
): InvocationProfiler => {
  const session = new Session();
  let started = false;
  let profile: Profiler.Profile | undefined;
  return {
    async start() {
      session.connect();
      try {
        await session.post("Profiler.enable");
        await session.post("Profiler.setSamplingInterval", { interval: PROFILE_INTERVAL_US });
        await session.post("Profiler.start");
        started = true;
      } catch (error) {
        session.disconnect();
        throw error;
      }
    },
    async stop() {
      if (!started) {
        return;
      }
      try {
        ({ profile } = await session.post("Profiler.stop"));
      } finally {
        started = false;
        session.disconnect();
      }
    },
    async save() {
      if (!profile) {
        throw new Error("profile did not stop successfully");
      }
      const file = `${String(entries.length).padStart(5, "0")}-${identity.operation}-${identity.runtime_arm}.cpuprofile`;
      const contents = JSON.stringify(profile);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, file), contents, { flag: "wx" });
      entries.push({
        ...identity,
        file,
        sha256: createHash("sha256").update(contents).digest("hex"),
        summary: summarizeProfile(profile),
      });
    },
  };
};
