import { useEffect, useState } from "react";
import { client } from "./client";
import type { Ticket } from "./tickets";

interface Props {
  id: string;
  onEdit: () => void;
  onBack: () => void;
}

export const TicketDetail = ({ id, onEdit, onBack }: Props): React.JSX.Element => {
  const [t, setT] = useState<Ticket | undefined>(undefined);
  const [err, setErr] = useState<string | undefined>(undefined);

  useEffect(() => {
    void (async () => {
      try {
        const row = await client.table<Ticket>("tickets").where({ _id: id }).first();
        setT(row);
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
  }, [id]);

  if (err !== undefined) return <p style={{ color: "crimson" }}>Error: {err}</p>;
  if (t === undefined) return <p>Loading…</p>;

  return (
    <div>
      <button onClick={onBack}>← Back</button>
      <h2>{t.title}</h2>
      <dl>
        <dt>Status</dt>
        <dd>{t.status}</dd>
        <dt>Assignee</dt>
        <dd>{t.assignee}</dd>
        <dt>Priority</dt>
        <dd>{t.priority}</dd>
        <dt>Created</dt>
        <dd>{t.created_at}</dd>
      </dl>
      <button onClick={onEdit}>Edit</button>
      <button
        style={{ marginLeft: 8, color: "crimson" }}
        onClick={async () => {
          if (!confirm("Delete this ticket?")) return;
          await client.table<Ticket>("tickets").where({ _id: id }).delete();
          onBack();
        }}
      >
        Delete
      </button>
    </div>
  );
};
