import { useEffect, useState } from "react";
import { client } from "./client.ts";
import { PRIORITIES, STATUSES, type Ticket } from "../../../types.ts";

type Draft = Pick<Ticket, "title" | "status" | "priority" | "assignee">;

const EMPTY: Draft = { title: "", status: "open", priority: "med", assignee: "" };
const ROW = { marginBottom: 12 };

export const TicketForm = ({
  id,
  onDone,
}: {
  id: string | null;
  onDone: () => void;
}): React.JSX.Element => {
  const [initial, setInitial] = useState<Draft | undefined>(id === null ? EMPTY : undefined);

  useEffect(() => {
    if (id === null) return;
    void (async () => {
      const row = await client.table<Ticket>("tickets").where({ _id: id }).first();
      setInitial(row ?? EMPTY);
    })();
  }, [id]);

  if (initial === undefined) return <p>Loading…</p>;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const draft: Draft = {
          title: String(fd.get("title")),
          status: fd.get("status") as Ticket["status"],
          priority: fd.get("priority") as Ticket["priority"],
          assignee: String(fd.get("assignee")),
        };
        const tickets = client.table<Ticket>("tickets");
        if (id === null) {
          await tickets.insert({ ...draft, created_at: new Date().toISOString() });
        } else {
          await tickets.where({ _id: id }).update(draft);
        }
        onDone();
      }}
    >
      <div style={ROW}>
        <label>
          Title
          <input
            name="title"
            defaultValue={initial.title}
            required
            style={{ display: "block", width: "100%" }}
          />
        </label>
      </div>
      <div style={ROW}>
        <label>
          Status&nbsp;
          <select name="status" defaultValue={initial.status}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label style={{ marginLeft: 12 }}>
          Priority&nbsp;
          <select name="priority" defaultValue={initial.priority}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={ROW}>
        <label>
          Assignee
          <input name="assignee" defaultValue={initial.assignee} style={{ display: "block" }} />
        </label>
      </div>
      <button type="submit">{id === null ? "Create" : "Save"}</button>
      <button type="button" style={{ marginLeft: 8 }} onClick={onDone}>
        Cancel
      </button>
    </form>
  );
};
