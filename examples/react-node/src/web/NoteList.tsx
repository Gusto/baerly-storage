import { useLiveQuery } from "baerly-storage/client/react";
import type { Note } from "../../types.ts";

export const NoteList = ({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element => {
  const result = useLiveQuery<Note>({ table: "notes" });

  if (result.status === "error") {
    return <p style={{ color: "crimson" }}>Error: {result.error.message}</p>;
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
    <ul style={{ listStyle: "none", padding: 0 }}>
      {sorted.map((n) => (
        <li
          key={n._id}
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #eee",
            cursor: "pointer",
          }}
          onClick={() => onOpen(n._id)}
        >
          <div>{n.body}</div>
          <small style={{ color: "#666" }}>{n.created_at}</small>
        </li>
      ))}
    </ul>
  );
};
