# baerly-storage hero demo — "it's just a bucket"
#
# Render with VHS (https://github.com/charmbracelet/vhs):
#   vhs docs/assets/demo.tape   ->   docs/assets/demo.gif
#
# The payoff is the final frame: a write went through, and the entire
# database is visible as plain objects in the bucket. No database server
# saw any of it. Run against a real (or local Minio) bucket so `aws s3 ls`
# shows the actual log/snapshot/content objects.
#
# The write/read steps hit the kernel's real HTTP surface
# (`POST`/`GET /v1/c/<collection>`, body `{ doc }`, `{ data, _meta }`
# response — see packages/server/src/contract.ts) — i.e. exactly what
# `db.collection("tickets").insert(...)` compiles to over the wire.
#
# Prereqs the recorder stages: a scaffolded app **running** with its `db`
# pointed at $DEMO_BUCKET and reachable at $BASE_URL, a bearer $TOKEN its
# verifier accepts, and `aws` configured for that bucket (or swap the
# final command for `baerly inspect`).

Output docs/assets/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1100
Set Height 640
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set PlaybackSpeed 1.0

# --- write a row ---------------------------------------------------------
Type "# 1. write a row — a normal request to your app handler, no database server"
Enter
Sleep 600ms
Type `curl -s "$BASE_URL/v1/c/tickets" -H "Authorization: Bearer $TOKEN" -d '{"doc":{"title":"Onboard Alex","status":"open"}}'`
Enter
Sleep 2s
# → 201 { "_id": "..." }

# --- read it back --------------------------------------------------------
Type "# 2. read it back"
Enter
Sleep 400ms
Type `curl -s "$BASE_URL/v1/c/tickets" -H "Authorization: Bearer $TOKEN"`
Enter
Sleep 2s
# → 200 { "data": [ { "_id": "...", "title": "Onboard Alex", "status": "open" } ], "_meta": { ... } }
# (filtered reads use ?where=<urlencoded JSON>, e.g. {"clauses":[{"op":"eq","field":"status","value":"open"}]})

# --- the reveal ----------------------------------------------------------
Type "# 3. now look in the bucket — that's the whole database"
Enter
Sleep 600ms
Type "aws s3 ls --recursive s3://$DEMO_BUCKET/"
Enter
Sleep 1s
# Expect: tickets/.../log/00000000, the content-addressed doc, snapshot,
# current.json — plain objects. No database server saw any of this.
Sleep 4s
