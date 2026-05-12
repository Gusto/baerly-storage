import { useEffect, useState } from "react";
import { client } from "./client";
import type { Ticket } from "./tickets";

const STATUSES = ["open", "in_progress", "closed"] as const;
const PRIORITIES = ["low", "med", "high"] as const;

// Form-state shape, locked to the editable fields. We can't `Omit`
// from `Ticket` directly because Ticket extends `JSONArraylessObject`
// (an open index signature) — picked fields would inherit it and
// land as `JSONArrayless` instead of their literal types.
interface TicketForm {
  title: string;
  status: Ticket["status"];
  assignee: string;
  priority: Ticket["priority"];
}

export const TicketForm = ({
  id,
  onDone,
}: {
  id: string | null;
  onDone: () => void;
}): React.JSX.Element => {
  const [form, setForm] = useState<TicketForm>({
    title: "",
    status: "open",
    assignee: "",
    priority: "med",
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (id === null) return;
    void (async () => {
      const row = await client.table<Ticket>("tickets").where({ _id: id }).first();
      if (row !== undefined) {
        setForm({
          title: row.title,
          status: row.status,
          assignee: row.assignee,
          priority: row.priority,
        });
      }
    })();
  }, [id]);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSubmitting(true);
        try {
          if (id === null) {
            await client.table<Ticket>("tickets").insert({
              title: form.title,
              status: form.status,
              assignee: form.assignee,
              priority: form.priority,
              created_at: new Date().toISOString(),
            });
          } else {
            await client.table<Ticket>("tickets").where({ _id: id }).update({
              title: form.title,
              status: form.status,
              assignee: form.assignee,
              priority: form.priority,
            });
          }
          onDone();
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <label>
        Title
        <br />
        <input
          value={form.title}
          required
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          style={{ width: "100%" }}
        />
      </label>
      <p />
      <label>
        Status&nbsp;
        <select
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value as Ticket["status"] })}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {"  "}
      <label>
        Priority&nbsp;
        <select
          value={form.priority}
          onChange={(e) => setForm({ ...form, priority: e.target.value as Ticket["priority"] })}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <p />
      <label>
        Assignee
        <br />
        <input
          value={form.assignee}
          onChange={(e) => setForm({ ...form, assignee: e.target.value })}
        />
      </label>
      <p />
      <button type="submit" disabled={submitting}>
        {id === null ? "Create" : "Save"}
      </button>
      {"  "}
      <button type="button" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
};
