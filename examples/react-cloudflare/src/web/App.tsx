import { BaerlyProvider, useInsert } from "baerly-storage/client/react";
import { client } from "./client.ts";
import { NoteList } from "./NoteList.tsx";
import type { Note } from "../../baerly.config.ts";

const NewNoteForm = () => {
  const { mutate: insertNote, isPending, error } = useInsert<Note>({ table: "notes" });
  return (
    <form
      className="new-note"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const body = String(new FormData(form).get("body")).trim();
        if (body.length === 0) {
          return;
        }
        await insertNote({ body });
        form.reset();
      }}
    >
      <textarea name="body" placeholder="Write a note…" rows={2} required />
      <button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Add note"}
      </button>
      {error && <p className="error">Save failed: {error.message}</p>}
    </form>
  );
};

export const App = () => (
  <BaerlyProvider client={client}>
    <div className="app">
      <h1>Notes</h1>
      <NewNoteForm />
      <NoteList />
    </div>
  </BaerlyProvider>
);
