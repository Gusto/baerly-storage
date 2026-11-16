Write `export async function insertOnce(tickets, doc)` where `tickets` is a
collection from this library and `doc` is a row that includes an explicit
`_id`. It inserts `doc` and returns the `_id`.

If the insert fails because the commit outcome is unknown (the write may or
may not have landed), do not blindly insert again: read the row back by that
`_id` first. If it is there, return its `_id`. If it is not there, insert
`doc` once more and return its `_id`. Any other error is rethrown.

Export it from `solution.ts`; no `main` is needed. Use only the documented
API.
