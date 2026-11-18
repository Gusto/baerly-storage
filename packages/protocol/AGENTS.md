# @baerly/protocol — agent quickref

`@baerly/protocol` is the pure, I/O-free kernel: types, errors, constants, JSON merge-patch, hashing, the `Storage` interface and its in-memory impl. It is workspace-internal; see `README.md`. The server kernel in `packages/server/src/` follows the same rules below.

## Determinism rules

Anything that is hashed, stored or compared across processes must come out the same on every host and every run. The code follows these today; keep it that way. Each rule lists today's deliberate exceptions.

- **Byte order, not string order.** Compare keys and document `_id`s as UTF-8 bytes (`utf8-scalar-v1`: `compareDocIds` in `packages/server/src/snapshot-doc-id.ts`), never with JS `<`, default `.sort()` or `localeCompare`. Those use UTF-16 code units, which disagree with byte order for U+E000–U+FFFF against astral code points, and storage `list` order is byte order. Exception: the monolithic snapshot sorts `docs` with `<` (`packages/server/src/compactor.ts`, "Step 5"); the snapshot-format cut moves it to `utf8-scalar-v1`, because changing it alone changes snapshot bytes and hashes.
- **No meaning from `Map` or object insertion order.** Sort into a canonical order before hashing or storing a collection (the compactor sorts the fold `Map` by `_id` before encoding). Exception: `encodeJsonBytes` emits keys in insertion order and is not canonical, so equal values can encode differently. This is safe only for the categories listed below.
- **Explicit numeric domains.** Sequence numbers, sizes and counts are safe integers with stated bounds (`seq`: 0 .. 2^53 − 1, checked with `Number.isSafeInteger`; `timestamp()` accepts only non-negative integers below 2^`TIMESTAMP_BIT_WIDTH`). Nothing durable relies on `number` being a float or on `JSON.stringify` number formatting.
- **Plain data at storage and wire boundaries.** Serialized values hold no class instances, prototypes, getters or `undefined` holes. `assertDocumentValues` rejects them at ingress.
- **Boundary inputs are explicit arguments.** Pure code takes the clock and randomness as parameters (`timestamp(epoch)`, `runGc`'s `now` / `monotonicNow`, retry's `random`) rather than calling `Date.now()`, `new Date()`, `Math.random()`, `crypto.*` or `performance.now()`. The edges that read them directly are: `uuidv7` / `uuid()` / `mintGeneration` (minting), `Writer` (session id and one commit-time read per slot), `observability/**`, the long-poll deadline in `http/since.ts`, and `MemoryStorage.put`'s `serverDate`. New direct reads belong at an edge like these.

### JSON categories

Durable JSON falls into three categories, and the rules bind hardest on the last two.

- **Parse-only.** Read with `JSON.parse` and validated by field: `current.json`, the GC pending record. Key order carries no meaning.
- **Byte-hashed.** The key or hash covers the literal bytes: snapshot bodies (the filename embeds the SHA-256) and legacy `content/` keys. Readers must verify the stored bytes, never re-encode them.
- **Equality-sensitive.** Compared by value to decide what happened: log-entry adoption in `packages/server/src/log-conflict-adoption.ts` compares `JSON.stringify(existing)` with `JSON.stringify(self)`. That is correct only because both sides come from the same encoder and `JSON.parse` / `JSON.stringify` preserve key order; its header comment states the premise. It is the one documented exception to "no meaning from insertion order". A content-addressed tree adopts only on byte-identical content.
