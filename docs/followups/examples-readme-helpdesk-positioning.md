# `examples/README.md`: helpdesk positioning contradicts itself

**Severity: LOW. Confusing first read for anyone landing on the
examples catalog. Single-doc fix.**

`examples/README.md` describes `examples/helpdesk` two ways
within the same page:

- Line 95: "Fully-built ticket CRUD app"
- Line 101: "**Dev-only teaching fixture**, not a deployable
  production template"

Both are accurate — helpdesk *is* a complete CRUD app *and* it's
not a deployable template — but the README puts a new reader in
a contradiction loop before they pick a starting point.

The catalog also lists the four scaffoldable templates alongside
helpdesk without surfacing the deploy/teaching distinction.

## Fix

Reframe the page around one decision: **what does Baerly feel
like?** vs **what do I scaffold?**

Suggested structure:

```markdown
# Examples

## Take the tour
[`examples/helpdesk/`](./helpdesk/) — a working ticket CRUD
app over `LocalFsStorage`. Single Vite process; runs end-to-end
without S3, Minio, or any cloud. Read this first to feel what
Baerly is. **Not a deploy target** — for production scaffolds,
see below.

## Scaffold a real project
- [`examples/minimal-cloudflare/`](./minimal-cloudflare/) — ...
- [`examples/minimal-node/`](./minimal-node/) — ...
- [`examples/helpdesk-cloudflare/`](./helpdesk-cloudflare/) — ...
```

Either delete the "fully-built CRUD app" framing or recast it as
"complete UI tour" so it doesn't read as "production-ready." The
"dev-only teaching fixture" line is the truthful framing — lead
with that.

## Cross-references

- Item H7 (in next-batch.md) raised whether `examples/helpdesk/`
  should exist at all given its overlap with `helpdesk-cloudflare`.
  This doc only fixes the README; the deeper "should helpdesk
  exist?" question is a separate decision and stays in the
  longer-form backlog if/when we revisit examples.
