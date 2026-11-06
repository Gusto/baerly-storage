---
"@gusto/baerly-storage": patch
---

A `useQuery` fetch is now cancelled when its query is superseded (its dependencies change) or unmounted: the in-flight GET and any retry wait, transport or `MaintenancePending`, stop at once instead of running on in the background. A fetch shared by several components is cancelled only when the last one detaches, and a cancelled fetch never surfaces as an error.
