import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared state shape exposed by every public mutation hook.
 * Discriminating on `isPending` and the optional `error` is enough
 * for typical UI; the `data` field carries the last successful
 * return value when callers want it.
 *
 * @internal
 */
export interface UseMutationResult<TArgs extends ReadonlyArray<unknown>, TResult> {
  /**
   * Run the mutation. Returns the resolved value; throws if the
   * underlying call rejects (so callers can `try/catch` if they want
   * to short-circuit on error). The `error` field is also populated
   * on the next render, for declarative rendering.
   *
   * Calling `mutate` while a previous call is still in flight aborts
   * the previous call. Calling after unmount is a no-op (no
   * setState).
   */
  readonly mutate: (...args: TArgs) => Promise<TResult>;
  /** `true` while a call is in flight. */
  readonly isPending: boolean;
  /** Last error, if the most recent call rejected. Cleared by `reset()` or by starting a new call. */
  readonly error: Error | undefined;
  /** Last successful return value, if any. */
  readonly data: TResult | undefined;
  /** Clears `error` and `data`. Does not abort an in-flight call. */
  readonly reset: () => void;
}

/**
 * Generic mutation primitive shared by the typed surface
 * ({@link useInsert}, {@link useUpdate}, {@link useReplace},
 * {@link useDelete}). Owns one `AbortController` per call — a new
 * `mutate(...)` aborts any in-flight call, and unmount aborts the
 * current call.
 *
 * @internal Not exported from the package barrel. The typed hooks
 * are the public surface; if a generic shape becomes needed
 * externally, we can lift this then.
 */
export const useMutation = <TArgs extends ReadonlyArray<unknown>, TResult>(
  perform: (signal: AbortSignal, ...args: TArgs) => Promise<TResult>,
): UseMutationResult<TArgs, TResult> => {
  const [isPending, setIsPending] = useState<boolean>(false);
  const [lastError, setError] = useState<Error | undefined>(undefined);
  const [data, setData] = useState<TResult | undefined>(undefined);

  // Keep the latest `perform` in a ref so `mutate` is stable across
  // renders. Without this, every hook user would need to memoize
  // `mutate` to avoid retriggering downstream effects.
  const performRef = useRef(perform);
  performRef.current = perform;

  // Tracks the currently-in-flight controller so the next `mutate`
  // call or unmount cleanup can abort it. A single-slot ref is
  // sufficient because each new call supersedes the previous.
  const controllerRef = useRef<AbortController | undefined>(undefined);

  // Tracks unmount so an in-flight call's resolution doesn't setState
  // after the component is gone. React 18+ tolerates this silently,
  // but we still want the state to reflect the live tree only.
  const mountedRef = useRef<boolean>(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    },
    [],
  );

  const mutate = useCallback(async (...args: TArgs): Promise<TResult> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    if (mountedRef.current) {
      setIsPending(true);
      setError(undefined);
    }
    try {
      const result = await performRef.current(controller.signal, ...args);
      if (mountedRef.current && !controller.signal.aborted) {
        setData(result);
        setIsPending(false);
      }
      return result;
    } catch (error) {
      // Aborts come from our own controller (superseded call or
      // unmount). Drop them silently — neither caller wants to see
      // an "AbortError" in their UI.
      if (controller.signal.aborted) {
        throw error;
      }
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (mountedRef.current) {
        setError(wrapped);
        setIsPending(false);
      }
      throw wrapped;
    }
  }, []);

  const reset = useCallback((): void => {
    setError(undefined);
    setData(undefined);
  }, []);

  return { mutate, isPending, error: lastError, data, reset };
};
