import { type BaerlyConfig, BaerlyError, type UnboundConfig } from "@baerly/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BaerlyClient } from "../client.ts";
import { useBaerlyClient } from "./provider.ts";

/**
 * Tuple returned by {@link useMutation}. Positionally mirrors React
 * 19's `useActionState`: `[mutate, state]`. `mutate` is stable across
 * renders; `state` is a fresh object only when `isPending` or
 * `error` actually flips.
 */
export type UseMutationTuple<TConfig extends BaerlyConfig = UnboundConfig> = readonly [
  mutate: <T>(callback: (client: BaerlyClient<TConfig>) => Promise<T>) => Promise<T>,
  state: { readonly isPending: boolean; readonly error: BaerlyError | undefined },
];

/**
 * Imperative mutation hook. `mutate(callback)` runs the callback
 * against the real `BaerlyClient` and resolves to whatever the
 * callback returns; `state` carries `isPending` (refcounted across
 * concurrent submits — `true` until every in-flight call settles)
 * and `error` (last-wins; the most recent rejection until the next
 * successful call clears it).
 *
 * Errors are normalised to {@link BaerlyError}: a non-`BaerlyError`
 * throwable from the callback is wrapped under
 * `code: "MutationFailed"` with the original on `.cause`.
 *
 * @example
 * ```tsx
 * const [mutate, { isPending, error }] = useMutation();
 * <button
 *   disabled={isPending}
 *   onClick={() => mutate((client) => client.collection("notes").insert({ body }))}
 * >
 *   {isPending ? "Saving…" : "Save"}
 * </button>
 * {error ? <p>{error.message}</p> : null}
 * ```
 */
export const useMutation = <
  TConfig extends BaerlyConfig = UnboundConfig,
>(): UseMutationTuple<TConfig> => {
  const client = useBaerlyClient<TConfig>();
  const inFlightRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(true);
  const [isPending, setIsPending] = useState<boolean>(false);
  const [lastError, setLastError] = useState<BaerlyError | undefined>(undefined);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const mutate = useCallback(
    async <T>(callback: (c: BaerlyClient<TConfig>) => Promise<T>): Promise<T> => {
      const wasIdle = inFlightRef.current === 0;
      inFlightRef.current += 1;
      if (wasIdle && mountedRef.current) {
        setIsPending(true);
        setLastError(undefined);
      }
      try {
        const result = await callback(client);
        return result;
      } catch (error) {
        const be =
          error instanceof BaerlyError
            ? error
            : new BaerlyError(
                "MutationFailed",
                error instanceof Error ? error.message : String(error),
                error,
              );
        if (mountedRef.current) {
          setLastError(be);
        }
        throw be;
      } finally {
        inFlightRef.current -= 1;
        if (inFlightRef.current === 0 && mountedRef.current) {
          setIsPending(false);
        }
      }
    },
    [client],
  );

  const state = useMemo(() => ({ isPending, error: lastError }), [isPending, lastError]);

  return [mutate, state] as const;
};
