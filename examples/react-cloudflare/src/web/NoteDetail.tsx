import { useDelete, useLiveDocument } from "baerly-storage/client/react";
import type { Note } from "../../types.ts";

interface Props {
  id: string;
  onEdit: () => void;
  onBack: () => void;
}

export const NoteDetail = ({ id, onEdit, onBack }: Props) => {
  const result = useLiveDocument<Note>({ table: "notes", id });
  const {
    mutate: deleteNote,
    isPending: isDeleting,
    error: deleteError,
  } = useDelete({ table: "notes" });

  if (result.status === "error") {
    return <p className="error">Error: {result.error.message}</p>;
  }
  if (result.status === "loading") {
    return <p>Loading…</p>;
  }
  if (result.status === "missing") {
    return <p>Not found.</p>;
  }
  const n = result.row;

  return (
    <div>
      <button onClick={onBack}>← Back</button>
      <p className="note-body">{n.body}</p>
      <small className="muted">Created {n.created_at}</small>
      <div className="actions">
        <button onClick={onEdit}>Edit</button>
        <button
          className="danger"
          disabled={isDeleting}
          onClick={async () => {
            if (!window.confirm("Delete this note?")) {
              return;
            }
            await deleteNote(id);
            onBack();
          }}
        >
          {isDeleting ? "Deleting…" : "Delete"}
        </button>
      </div>
      {deleteError && <p className="error">Delete failed: {deleteError.message}</p>}
    </div>
  );
};
