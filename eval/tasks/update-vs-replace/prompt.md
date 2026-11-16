The `tickets` collection holds one row with the fields `title`, `status`
("open") and `note` ("temp"). Find its `_id` via the collection.

Mark the row closed (`status: "closed"`) and delete its `note` field,
leaving `title` and every other field untouched.

Export `export async function main(db)` taking a `Db` (already constructed;
do not create storage). Use only the documented API.
