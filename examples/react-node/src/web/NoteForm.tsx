import { useInsert, useLiveDocument, useUpdate } from "baerly-storage/client/react";
import type { Note } from "../../types.ts";

type Draft = Pick<Note, "body">;

export const NoteForm = ({ id, onDone }: { id?: string; onDone: () => void }) => {
  const existing = useLiveDocument<Note>({
    table: "notes",
    id: id ?? "",
    enabled: id !== undefined,
  });

  const {
    mutate: insertNote,
    isPending: isInserting,
    error: insertError,
  } = useInsert<Note>({ table: "notes" });
  const {
    mutate: updateNote,
    isPending: isUpdating,
    error: updateError,
  } = useUpdate<Note>({ table: "notes" });
  const submitting = isInserting || isUpdating;
  const submitError = insertError ?? updateError;

  if (id !== undefined) {
    if (existing.status === "loading") {
      return <p>Loading…</p>;
    }
    if (existing.status === "error") {
      return <p className="error">Error: {existing.error.message}</p>;
    }
  }
  const initial: Draft = existing.status === "ok" ? { body: existing.row.body } : { body: "" };
  const idleLabel = id === undefined ? "Create" : "Save";

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const draft: Draft = { body: String(fd.get("body")) };
        try {
          if (id === undefined) {
            await insertNote({ ...draft, created_at: new Date().toISOString() });
          } else {
            await updateNote(id, draft);
          }
          onDone();
        } catch {
          // Error is already surfaced via `submitError`; stay on the form.
        }
      }}
    >
      <div className="field">
        <label>
          Body
          <textarea name="body" defaultValue={initial.body} required rows={4} />
        </label>
      </div>
      <div className="actions">
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : idleLabel}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      {submitError && <p className="error">Save failed: {submitError.message}</p>}
    </form>
  );
};
