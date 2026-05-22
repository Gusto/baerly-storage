import { useDelete, useLiveDocument } from "baerly-storage/client/react";
import type { Note } from "../../types.ts";

interface Props {
  id: string;
  onEdit: () => void;
  onBack: () => void;
}

export const NoteDetail = ({ id, onEdit, onBack }: Props): React.JSX.Element => {
  const result = useLiveDocument<Note>({ table: "notes", id });
  const {
    mutate: deleteNote,
    isPending: isDeleting,
    error: deleteError,
  } = useDelete({ table: "notes" });

  if (result.status === "error") {
    return <p style={{ color: "crimson" }}>Error: {result.error.message}</p>;
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
      <p style={{ whiteSpace: "pre-wrap", marginTop: 16 }}>{n.body}</p>
      <small style={{ color: "#666" }}>Created {n.created_at}</small>
      <div style={{ marginTop: 16 }}>
        <button onClick={onEdit}>Edit</button>
        <button
          style={{ marginLeft: 8, color: "crimson" }}
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
      {deleteError && (
        <p style={{ color: "crimson", marginTop: 8 }}>Delete failed: {deleteError.message}</p>
      )}
    </div>
  );
};
