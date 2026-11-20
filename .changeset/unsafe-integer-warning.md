---
"@gusto/baerly-storage": patch
---

A committed write carrying an integer above 2^53 now logs an `unsafe_integer` warning naming the field and counts it on `db.write.unsafe_integer_total`. `JSON.parse` rounds such numbers before the database sees them, so store 64-bit ids (Snowflake, Postgres `bigint`) as strings. Nothing is refused.
