import { z } from "zod";
import { defineConfig } from "@gusto/baerly-storage/config";
import type { Db } from "@gusto/baerly-storage";

const TaskSchema = z.object({
  _id: z.string(),
  title: z.string(),
});

export const config = defineConfig({
  collections: {
    tasks: { schema: TaskSchema },
  },
});

export async function main(db: Db) {
  const { _id } = await db.collection("tasks").insert({ title: "x" });
  return db.collection("tasks").get(_id);
}
