import { useState } from "react";
import { BaerlyProvider } from "baerly-storage/client/react";
import { client } from "./client.ts";
import { TicketList } from "./TicketList.tsx";
import { TicketDetail } from "./TicketDetail.tsx";
import { TicketForm } from "./TicketForm.tsx";

type View = { kind: "list" } | { kind: "detail"; id: string } | { kind: "edit"; id: string | null };

const FRAME = { fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 960, margin: "0 auto" };
const HEADER = { display: "flex", justifyContent: "space-between", marginBottom: 24 };

export const App = (): React.JSX.Element => {
  const [view, setView] = useState<View>({ kind: "list" });
  return (
    <BaerlyProvider client={client}>
      <div style={FRAME}>
        <header style={HEADER}>
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
        {view.kind === "edit" && (
          <TicketForm id={view.id} onDone={() => setView({ kind: "list" })} />
        )}
      </div>
    </BaerlyProvider>
  );
};
