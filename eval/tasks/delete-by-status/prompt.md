The `notes` collection has been pre-seeded with rows having either
`status: "open"` or `status: "closed"`.

Delete every `notes` row whose `status` is not `"open"`.

Export `export async function main(db)` taking a `Db` (already constructed;
do not create storage). Use only the documented API.
