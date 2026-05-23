import { useLiveQuery } from "baerly-storage/client/react";
import type { Note } from "../../types.ts";

export const NoteList = ({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element => {
  const result = useLiveQuery<Note>({ table: "notes" });

  if (result.status === "error") {
    return <p className="error">Error: {result.error.message}</p>;
  }
  if (result.status === "loading") {
    return <p>Loading…</p>;
  }
  if (result.rows.length === 0) {
    return <p>No notes. Click "+ New note".</p>;
  }

  // Newest first.
  const sorted = [...result.rows].toSorted((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <ul className="note-list">
      {sorted.map((n) => (
        <li key={n._id} onClick={() => onOpen(n._id)}>
          <div>{n.body}</div>
          <small className="muted">{n.created_at}</small>
        </li>
      ))}
    </ul>
  );
};
