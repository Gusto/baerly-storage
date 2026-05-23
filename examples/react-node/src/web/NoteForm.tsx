import { useEffect, useState } from "react";
import { useBaerlyClient, useInsert, useUpdate } from "baerly-storage/client/react";
import type { Note } from "../../types.ts";

type Draft = Pick<Note, "body">;
const EMPTY: Draft = { body: "" };

const submitButtonLabel = (submitting: boolean, isNew: boolean): string => {
  if (submitting) {
    return "Saving…";
  }
  return isNew ? "Create" : "Save";
};

export const NoteForm = ({ id, onDone }: { id?: string; onDone: () => void }) => {
  const client = useBaerlyClient();
  const [initial, setInitial] = useState<Draft | undefined>(id === undefined ? EMPTY : undefined);

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

  useEffect(() => {
    if (id === undefined) {
      return;
    }
    void (async () => {
      const row = await client.table<Note>("notes").get(id);
      setInitial(row === undefined ? EMPTY : { body: row.body });
    })();
  }, [client, id]);

  if (initial === undefined) {
    return <p>Loading…</p>;
  }

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
          {submitButtonLabel(submitting, id === undefined)}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      {submitError && <p className="error">Save failed: {submitError.message}</p>}
    </form>
  );
};
