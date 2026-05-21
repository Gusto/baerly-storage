import { useCallback } from "react";
import type { DocumentData } from "@baerly/protocol";
import { useBaerlyClient } from "./provider.ts";
import { useMutation, type UseMutationResult } from "./use-mutation.ts";

export interface UseReplaceOptions {
  /** Table to replace in. */
  readonly table: string;
}

export type UseReplaceResult<T extends DocumentData> = UseMutationResult<
  [id: string, doc: T],
  void
>;

/**
 * Mutation hook for `client.table(...).replace(id, doc)`. Issues
 * `PUT /v1/t/:table/:id` — whole-document overwrite. Unlike
 * {@link useUpdate}, omitted keys are removed (not preserved). Pair
 * with `useLiveDocument` to read-modify-write.
 *
 * Single-row replace by `_id`; the hook signature is `mutate(id, doc)`
 * and mirrors {@link ClientTable.replace}.
 *
 * @example
 * ```tsx
 * const live = useLiveDocument<Ticket>({ table: "tickets", id });
 * const { mutate: saveTicket, isPending } = useReplace<Ticket>({ table: "tickets" });
 *
 * if (live.status !== "ok") return null;
 * return (
 *   <button
 *     disabled={isPending}
 *     onClick={() => void saveTicket(id, { ...live.row, title: nextTitle })}
 *   >
 *     Save
 *   </button>
 * );
 * ```
 */
export const useReplace = <T extends DocumentData = DocumentData>(
  opts: UseReplaceOptions,
): UseReplaceResult<T> => {
  const { table } = opts;
  const client = useBaerlyClient();
  return useMutation(
    useCallback(
      (signal, id: string, doc: T) => client.table<T>(table).replace(id, doc, { signal }),
      [client, table],
    ),
  );
};
