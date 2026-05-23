import { useState } from "react";
import { BaerlyProvider } from "baerly-storage/client/react";
import { client } from "./client.ts";
import { NoteList } from "./NoteList.tsx";
import { NoteDetail } from "./NoteDetail.tsx";
import { NoteForm } from "./NoteForm.tsx";

type View = { kind: "list" } | { kind: "detail"; id: string } | { kind: "edit"; id: string | null };

export const App = (): React.JSX.Element => {
  const [view, setView] = useState<View>({ kind: "list" });
  return (
    <BaerlyProvider client={client}>
      <div className="app">
        <header className="app-header">
          <h1>Notes</h1>
          <button onClick={() => setView({ kind: "edit", id: null })}>+ New note</button>
        </header>
        {view.kind === "list" && <NoteList onOpen={(id) => setView({ kind: "detail", id })} />}
        {view.kind === "detail" && (
          <NoteDetail
            id={view.id}
            onEdit={() => setView({ kind: "edit", id: view.id })}
            onBack={() => setView({ kind: "list" })}
          />
        )}
        {view.kind === "edit" && <NoteForm id={view.id} onDone={() => setView({ kind: "list" })} />}
      </div>
    </BaerlyProvider>
  );
};
