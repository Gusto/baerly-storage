import { useState } from "react";
import { TicketList } from "./TicketList";
import { TicketDetail } from "./TicketDetail";
import { TicketForm } from "./TicketForm";

type View = { kind: "list" } | { kind: "detail"; id: string } | { kind: "edit"; id: string | null }; // null = new

export const App = (): React.JSX.Element => {
  const [view, setView] = useState<View>({ kind: "list" });

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: 24,
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Baerly Helpdesk</h1>
        <button onClick={() => setView({ kind: "edit", id: null })}>+ New ticket</button>
      </header>
      {view.kind === "list" && <TicketList onOpen={(id) => setView({ kind: "detail", id })} />}
      {view.kind === "detail" && (
        <TicketDetail
          id={view.id}
          onEdit={() => setView({ kind: "edit", id: view.id })}
          onBack={() => setView({ kind: "list" })}
        />
      )}
      {view.kind === "edit" && <TicketForm id={view.id} onDone={() => setView({ kind: "list" })} />}
    </div>
  );
};
