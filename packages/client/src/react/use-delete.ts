import { useCallback } from "react";
import type { DocumentData } from "@baerly/protocol";
import { useBaerlyClient } from "./provider.ts";
import { useMutation, type UseMutationResult } from "./use-mutation.ts";

export interface UseDeleteOptions {
  /** Table to delete from. */
  readonly table: string;
}

export type UseDeleteResult = UseMutationResult<[id: string], { readonly deleted: number }>;

/**
 * Mutation hook for `client.table(...).delete(id)`. Issues
 * `DELETE /v1/t/:table/:id`. Returns `{ deleted: 1 }` when a row
 * was removed and `{ deleted: 0 }` when no row matched — the 404
 * case is not surfaced as an error, mirroring the in-process
 * `Query.delete()` shape.
 *
 * @example
 * ```tsx
 * const { mutate: removeTicket, isPending, error } = useDelete<Ticket>({ table: "tickets" });
 *
 * <button
 *   disabled={isPending}
 *   onClick={async () => {
 *     if (!window.confirm("Delete this ticket?")) return;
 *     await removeTicket(id);
 *     onBack();
 *   }}
 * >
 *   Delete
 * </button>
 * ```
 */
export const useDelete = <T extends DocumentData = DocumentData>(
  opts: UseDeleteOptions,
): UseDeleteResult => {
  const { table } = opts;
  const client = useBaerlyClient();
  return useMutation(
    useCallback(
      (signal, id: string) => client.table<T>(table).delete(id, { signal }),
      [client, table],
    ),
  );
};
