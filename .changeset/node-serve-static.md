---
"@gusto/baerly-storage": patch
---

`baerlyNode({ webRoot })` now serves files through `@hono/node-server/serve-static` and refuses two things the old server allowed: a symlink inside `webRoot` that resolves outside it, and any dotfile or dot-directory (`/.env`, `/.git/config`) other than `/.well-known/*`. Both return the 404 envelope. An HTML navigation to an escaping symlink is treated as a miss and gets `index.html`; a dotfile request gets the 404 even for an HTML navigation.

Other differences from the previous static server:

- Responses carry `Last-Modified`, and a `Range` request gets `206 Partial Content` (or `416` when unsatisfiable).
- Percent-encoded names still work (`/my%20file.txt`, `/caf%C3%A9.txt`), but a path holding an encoded reserved character (`%2F`, `%3F`, `%23`) or a literal `%` (`%25`, so `/100%25.txt`) returns 404. Rename such files; Vite's hashed output never contains them.
- MIME types follow Hono's table: `.json` and `.map` lose the `; charset=utf-8` suffix, `.svg` gains it, and more extensions are recognized.
- A request for a directory without a trailing slash (`/docs`) serves that directory's `index.html`.
- A `webRoot` that does not exist is logged with `console.error` when the server is built.
