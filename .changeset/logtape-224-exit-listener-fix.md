---
'@gusto/baerly-storage': patch
---

Bump `@logtape/logtape` 2.2.2 → 2.2.4 to pick up the upstream fix for the
`configure()` process exit-listener leak ([dahlia/logtape#192](https://github.com/dahlia/logtape/issues/192)).
Previously each `configure()` registered a new `process.on("exit", …)` hook
without removing the prior one; 2.2.4 unregisters the previous dispose hook
before registering a new one. Production adapters call `configureObservability`
once so nothing shipped broken, but repeated reconfiguration in one process
(test suites, hot-reload) no longer leaks listeners. No public API changes.
