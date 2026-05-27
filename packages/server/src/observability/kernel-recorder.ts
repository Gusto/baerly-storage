import { type MetricsRecorder, noopMetricsRecorder } from "@baerly/protocol";

let current: MetricsRecorder = noopMetricsRecorder;

/**
 * Set the kernel-wide {@link MetricsRecorder} consumed by {@link Writer}
 * and the background maintenance loops (compactor / GC). Adapters call
 * this once at boot with their tee'd recorder; tests call it in
 * `beforeEach` and pair with {@link resetKernelMetricsRecorder} in
 * `afterEach` to avoid cross-test leakage.
 *
 * @internal — public consumers should not touch this; the operator
 * recorder flows in through the adapter `metrics` option (see
 * `@baerly/adapter-cloudflare` / `@baerly/adapter-node`).
 */
export const setKernelMetricsRecorder = (recorder: MetricsRecorder): void => {
  current = recorder;
};

/** @internal */
export const getKernelMetricsRecorder = (): MetricsRecorder => current;

/** @internal — test hook to restore the default no-op recorder. */
export const resetKernelMetricsRecorder = (): void => {
  current = noopMetricsRecorder;
};
