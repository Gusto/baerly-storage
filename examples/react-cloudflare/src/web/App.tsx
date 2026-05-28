import { BaerlyProvider, useMutation } from "@gusto/baerly-storage/client/react";
import { client } from "./client.ts";
import { NoteList } from "./NoteList.tsx";

const NewNoteForm = () => {
  const [mutate, { isPending, error }] = useMutation();
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
        await mutate((c) => c.collection("notes").insert({ body }));
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
