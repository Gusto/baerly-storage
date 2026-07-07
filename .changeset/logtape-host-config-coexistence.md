---
"@gusto/baerly-storage": minor
---

Observability: coexist with a host app's LogTape config instead of clobbering it.

baerly is a library, and LogTape's guidance is that only the application
configures LogTape. Previously the Node and Cloudflare adapters called
`configure({ reset: true })` at boot unconditionally, which silently wiped
the sinks and loggers of any app that had already configured LogTape (and,
depending on boot order, could itself be wiped). The documented "leave the
field unset to skip configuration" escape hatch never actually worked.

Now:

- `configureObservability` checks `getConfig()` first. When LogTape is
  already configured by something other than baerly, it leaves that config
  intact and emits a single `["logtape", "meta"]` notice rather than
  resetting it. baerly's own config is still reconfigured last-call-wins, so
  standalone servers and dev hot-reload are unchanged.
- `baerlyNode` / `baerlyWorker` accept `observability: false` to skip
  auto-configuration entirely, for apps that own the process-wide
  (isolate-wide on Workers) LogTape configuration themselves.
