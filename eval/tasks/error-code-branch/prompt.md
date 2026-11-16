In the `tickets` collection, insert `{ _id: "t-1", title: "first" }`, then
insert another row with the same `_id` `"t-1"`. The second insert fails.

Catch that error and return `{ code, retriable }` taken from it, where
`code` is the library's error code string and `retriable` says whether
re-running the operation can succeed.

Export `export async function main(db)` taking a `Db` (already constructed;
do not create storage). Use only the documented API.
