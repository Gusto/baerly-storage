// Result shapes for the eval harness. No I/O here.

/** A single task's correctness verdict for one agent attempt. */
export interface Verdict {
  readonly pass: boolean;
  readonly reason: string;
}

/** One run of one task. */
export interface RunResult {
  readonly task: string;
  readonly pass: boolean;
  readonly reason: string;
  /** The generated solution.ts source (kept in per-run JSON, never in the checked-in baseline). */
  readonly generated: string;
}

/** Aggregated per-task pass-rate across N runs. */
export interface TaskSummary {
  readonly name: string;
  readonly passRate: number; // 0..1
  readonly failures: ReadonlyArray<{ reason: string; generated: string }>;
}

/** The full eval report written to eval/results/<ts>.json. */
export interface EvalReport {
  /** Claude Code model alias as passed to `--model`. */
  readonly model: string;
  /** `claude --version` output. */
  readonly cliVersion: string;
  readonly surfaceKind: string; // "api-md+dts" | "api-md+dts+agents-md"
  readonly surfaceHash: string; // sha256 of the fed surface
  readonly runs: number;
  readonly tasks: ReadonlyArray<TaskSummary>;
  readonly aggregatePassRate: number;
}

export interface CliOptions {
  readonly runs: number;
  readonly model: string;
  readonly task?: string; // run only this task
  readonly withAgentsMd: boolean;
}
