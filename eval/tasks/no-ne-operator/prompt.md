The `tickets` collection holds rows with a `status` field, which is one of
"open", "blocked" or "done".

Return the number of rows whose `status` is NOT "done".

Export `export async function main(db)` taking a `Db` (already constructed;
do not create storage). Use only the documented API.
