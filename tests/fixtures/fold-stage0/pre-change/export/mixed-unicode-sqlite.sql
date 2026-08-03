CREATE TABLE "tickets" (
  "_id" TEXT NOT NULL PRIMARY KEY,
  "label" TEXT NOT NULL,
  "active" INTEGER NOT NULL,
  "score" INTEGER NOT NULL
);
INSERT INTO "tickets" ("_id", "label", "active", "score") VALUES ('a', 'ascii', 1, 1);
INSERT INTO "tickets" ("_id", "label", "active", "score") VALUES ('�', 'bmp', 0, 2);
INSERT INTO "tickets" ("_id", "label", "active", "score") VALUES ('𐀀', 'astral', 1, 3);
