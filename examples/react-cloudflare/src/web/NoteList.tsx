import { useState } from "react";
import { useMutation, useQuery } from "@gusto/baerly-storage/client/react";
import type { Note } from "../../baerly.config.ts";

const NoteRow = ({ note }: { note: Note }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [body, setBody] = useState(note.body);
  const [save, { isPending: isSaving, error: saveError }] = useMutation();
  const [del, { isPending: isDeleting, error: deleteError }] = useMutation();
  const error = saveError ?? deleteError;
  return (
    <li className="note-row">
      {isEditing ? (
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} />
      ) : (
        <p className="note-body">{note.body}</p>
      )}
      <div className="actions">
        {isEditing ? (
          <>
            <button
              disabled={isSaving}
              onClick={async () => {
                await save((c) => c.collection("notes").update(note._id, { body }));
                setIsEditing(false);
              }}
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
            <button
              disabled={isSaving}
              onClick={() => {
                setBody(note.body);
                setIsEditing(false);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => {
                setBody(note.body);
                setIsEditing(true);
              }}
            >
              Edit
            </button>
            <button
              className="danger"
              disabled={isDeleting}
              onClick={async () => {
                if (!window.confirm("Delete this note?")) {
                  return;
                }
                await del((c) => c.collection("notes").delete(note._id));
              }}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </button>
          </>
        )}
      </div>
      {error && <p className="error">{error.message}</p>}
    </li>
  );
};

export const NoteList = () => {
  const result = useQuery((c) => c.collection("notes").all() as Promise<Note[]>, []);
  if (result.status === "error") {
    return <p className="error">Error: {result.error.message}</p>;
  }
  if (result.status === "loading") {
    return <p>Loading…</p>;
  }
  // `result.status` is now "ok" or "refreshing" — `data` is `Note[]`.
  // ("skipped" is unreachable: this useQuery never returns the skip sentinel.)
  const rows = result.data ?? [];
  if (rows.length === 0) {
    return <p>No notes yet. Add one above.</p>;
  }
  // Newest first — UUIDv7 `_id`s sort by server mint time descending.
  const sorted = rows.toSorted((a, b) => b._id.localeCompare(a._id));
  return (
    <ul className="note-list">
      {sorted.map((n) => (
        <NoteRow key={n._id} note={n} />
      ))}
    </ul>
  );
};
