import { useState } from "react";
import { useDelete, useLiveQuery, useUpdate } from "baerly-storage/client/react";
import type { Note } from "../../baerly.config.ts";

const NoteRow = ({ note }: { note: Note }) => {
  const [body, setBody] = useState(note.body);
  const {
    mutate: updateNote,
    isPending: isSaving,
    error: saveError,
  } = useUpdate<Note>({ table: "notes" });
  const {
    mutate: deleteNote,
    isPending: isDeleting,
    error: deleteError,
  } = useDelete({ table: "notes" });
  const error = saveError ?? deleteError;
  return (
    <li className="note-row">
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} />
      <div className="actions">
        <button disabled={isSaving} onClick={() => updateNote(note._id, { body })}>
          {isSaving ? "Saving…" : "Save"}
        </button>
        <button
          className="danger"
          disabled={isDeleting}
          onClick={async () => {
            if (!window.confirm("Delete this note?")) {
              return;
            }
            await deleteNote(note._id);
          }}
        >
          {isDeleting ? "Deleting…" : "Delete"}
        </button>
      </div>
      {error && <p className="error">{error.message}</p>}
    </li>
  );
};

export const NoteList = () => {
  const result = useLiveQuery<Note>({ table: "notes" });
  if (result.status === "error") {
    return <p className="error">Error: {result.error.message}</p>;
  }
  if (result.status === "loading") {
    return <p>Loading…</p>;
  }
  if (result.rows.length === 0) {
    return <p>No notes yet. Add one above.</p>;
  }
  // Newest first — UUIDv7 `_id`s sort by server mint time descending.
  const sorted = result.rows.toSorted((a, b) => b._id.localeCompare(a._id));
  return (
    <ul className="note-list">
      {sorted.map((n) => (
        <NoteRow key={n._id} note={n} />
      ))}
    </ul>
  );
};
