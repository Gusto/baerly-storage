CREATE TABLE "tickets" (
  "_id" text NOT NULL PRIMARY KEY,
  "label" text NOT NULL,
  "active" boolean NOT NULL,
  "score" integer NOT NULL
);
INSERT INTO "tickets" ("_id", "label", "active", "score") VALUES ('a', 'ascii', true, 1);
INSERT INTO "tickets" ("_id", "label", "active", "score") VALUES ('�', 'bmp', false, 2);
INSERT INTO "tickets" ("_id", "label", "active", "score") VALUES ('𐀀', 'astral', true, 3);
