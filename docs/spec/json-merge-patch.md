---
title: JSON merge patch (RFC 7396)
audience: spec
summary: Sparse JSON updates plus the algebraic boundaries for safe patch coalescing.
last-reviewed: 2026-06-22
tags: [protocol, json, rfc-7396, rfc-7386, merge-patch]
related: [sync-protocol.md]
---

# JSON Merge Patch: Algebra and Applications

JSON Merge Patch is a [standardized](https://datatracker.ietf.org/doc/html/rfc7396) way to send the part of a JSON document that changed instead of sending the whole document. RFC 7396 obsoletes the earlier RFC 7386 document, but the merge rule is the same one used throughout this repo. A patch looks like the document it changes: object fields recurse, ordinary values replace, and `null` deletes a field.

That small rule is why baerly-storage can accept sparse patches at the API boundary. The server applies the patch to the current row, validates the merged row, and commits the resulting full post-image. The algebra in this page explains update semantics and local sparse-patch coalescing; today's committed `U` log entries are full post-images, not sparse patches.

The key constraint is **type-stable, delete-aware coalescing**. A _patch window_ is a contiguous list of patches you want to replace with one summary patch. _Type-stable_ means a path keeps the same JSON kind - object, array, or scalar - through that window. _Delete-aware_ means treating `null` deletes as information that can be lost if a later object patch re-adds only part of the deleted subtree.

- [Intro](#intro)
  - [Patches move the state forward](#patches-move-the-state-forward)
  - [Arrays replace wholesale and object-member null deletes](#arrays-replace-wholesale-and-object-member-null-deletes)
  - [Comparison to JSON Patch (RFC 6902)](#comparison-to-json-patch-rfc-6902)
- [Properties of JSON-merge-patch](#properties-of-json-merge-patch)
  - [Merges are not associative in general](#merges-are-not-associative-in-general)
  - [Merges are associative for structured documents](#merges-are-associative-for-structured-documents)
  - [Non-overlapping patches are commutative.](#non-overlapping-patches-are-commutative)
  - [Overlapping writes are last-write-wins](#overlapping-writes-are-last-write-wins)
  - [Merges are idempotent](#merges-are-idempotent)
  - [The identity patch is `undefined`](#the-identity-patch-is-undefined)
  - [The identity patch is not `{}`](#the-identity-patch-is-not-)
- [Tricks](#tricks)
  - [A list of patches forms an ordered log.](#a-list-of-patches-forms-an-ordered-log)
  - [Log can be coalesced if the patches are structured](#log-can-be-coalesced-if-the-patches-are-structured)
  - [Ordered Logs can be replayed multiple times](#ordered-logs-can-be-replayed-multiple-times)
  - [Ordered logs can repair speculative local gaps](#ordered-logs-can-repair-speculative-local-gaps)
- [JSON merge difference: `diff`](#json-merge-difference-diff)
  - [Identity is `undefined`](#identity-is-undefined)
  - [`Diff(a, a) = undefined`](#diffa-a--undefined)
  - [Diff is the inverse of merge](#diff-is-the-inverse-of-merge)
- [Structured JSON's Algebra: a Monoid Acting on States](#structured-jsons-algebra-a-monoid-acting-on-states)

---

## Intro

Start with a document. The examples use JS-like object literals for readability; wire JSON must quote keys and omit comments.

```
doc = {
	a: "foo",
	b: "bar",
	nested: {
		c: 5
		d: "str"
	}
}
```

In an object patch, `null` means "remove this member." This patch deletes `nested.d`:

```
{
	nested: {
		d: null
	}
}
```

Ordinary values add or replace fields. This patch adds `nested.new`:

```
{
	nested: {
		new: "value"
	}
}
```

One merge patch can combine adds, replacements, and deletes at different levels of the object:

```
{
	b: "new value", // update b
	nested: {
		d: null, // delete a single nested field
	}
	c: 21, // Add a new top-level field
}
```

---

### Patches move the state forward

If a JSON document is the state of a system, a merge patch is a state transition. The target state may be large; the transmitted patch only names the fields that change.

```
state_t+1 = merge(state_t, patch_t)
```

[_TypeScript implementation_](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/json.ts#L21)

---

### Arrays replace wholesale and object-member null deletes

Merge patches fit object-shaped documents best. Inside an object patch, `null` means delete this member, so a field that needs to distinguish "stored null" from "missing" does not fit the model.

Arrays are valid values, but RFC 7396 treats them as opaque values: an array in a patch replaces the target array. A one-element array patch is not an element update.

baerly-storage's implementation also skips three object-member names during merge traversal - `__proto__`, `constructor`, and `prototype` - as prototype-pollution hardening. The algebra below assumes allowed keys.

---

### Comparison to JSON Patch (RFC 6902)

`JSON Patch` ([RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902)) updates a document by applying a sequence of operations.

```
[
 { "op": "add", "path": "/baz", "value": "qux" },
 { "op": ...}
]
```

JSON Patch is more expressive: it can represent `null` values as ordinary values and can express insertion into an array. The tradeoff is that it is an imperative operation list. The algebra below depends on the smaller JSON Merge Patch rule: merge one value into another value.

Use JSON Patch when the document model needs those extra operations. baerly-storage's update path is shaped around object merge patches, so the rest of this page studies the properties of that narrower rule.

---

## Properties of JSON-merge-patch

### Merges are not associative in general

An associative binary function can be grouped in any way on a sequence and still produce the same result. That property is what makes compaction possible: adjacent elements can be summarized without asking where the summary will later be grouped.

```
merge(merge(a, b), c) == merge(a, merge(b, c)) // NOT TRUE IN GENERAL
```

The subtlety is that `merge` has different branches for objects and non-objects. When a path changes kind, grouping can change which branch runs.

```
merge(merge(0, {}), 0) = 0
!==
merge(0, merge({}, 0)) = {}
```

---

### Merges are associative for structured documents

The simplest structured patch window has two constraints: paths keep a stable JSON kind, and the window does not use `null` deletes. Under those constraints, regrouping does not change which branch of `merge` runs, so `merge` _is_ associative.

```
merge(merge(a, b), c) == merge(a, merge(b, c)) for structured docs
```

JSON generated from a typed model usually has the type-stable part of that shape: a field that is an object stays an object, and a field that is a scalar or array stays a leaf. Deletes need a separate caveat because `null` carries deletion intent, and a later object patch may re-add only part of the deleted subtree.

Associativity is useful for networked write coalescing. In a structured window, a list of patches can be merged into a single larger patch before transmission.

[_Verification source code_](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L123)

---

### Non-overlapping patches are commutative.

In a sparse-patch model, if two patches manipulate non-overlapping parts of the document, they can be applied in either order and produce the same result.

```
merge(merge(s, a), b) == merge(merge(s, b), a) if b intersect a == empty
```

Non-overlap means no written path in one patch is equal to, an ancestor of, or a descendant of a written path in the other patch. Sibling fields do not overlap. This is the collaboration case that sparse merge patches handle well: two writers touch different fields, so patch order does not affect the final state. baerly-storage's current committed `U` log entries are full row post-images, so row-level log replay is still last-write-wins by `seq`.

---

### Overlapping writes are last-write-wins

When two patches touch the same field, order matters. For example, one writer may delete a resource:

```
{
	resource1: null
}
```

while another updates the same resource:

```
{
	resource1: "new value"
}
```

If the patches are applied DELETE, UPDATE, the final value of `resource1` is `"new value"`. If they are applied UPDATE, DELETE, `resource1` is absent. The operations do not commute, so overlapping writes resolve by log order: last write wins.

---

### Merges are idempotent

If you apply the same patch twice in a row on top of a state, the second application has no further effect:

```
merge(merge(s, a), a) = merge(s, a)
```

States and patches are different domains because patches may contain `null` as deletion intent. This is _state-application_ idempotence; `merge(a,a)=a` does **not** hold for delete patches. For example, `merge({k:null},{k:null}) = {}`.

This is the narrow retry property: an accidental duplicate application immediately after the first one is harmless. It does not make reordered or interleaved retries harmless; overlapping writes are still resolved by the ordered log.

[_Verification source code_](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L133)

---

### The identity patch is `undefined`

Patching anything with `undefined` returns the original value:

```
merge(x, undefined) = x
```

Root identity needs a separate implementation value. JSON on the wire has no `undefined` literal, but an implementation still needs a value that means "no patch at all" at the root. Nested fields get that identity by omission: a field not mentioned in an object patch is left alone. The extra `undefined` symbol is an implementation value, not an additional wire value.

[_Verification source code_](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L81)

---

### The identity patch is not `{}`

Patching an object with the empty object does not modify it:

```
merge({a:""}, {}) = {a:""}
```

That makes `{}` look like the identity patch. It is not, because object patches replace scalar targets:

```
merge(0, {}) = {} // not 0
```

Thus, `{}` is not the identity patch over all JSON values. If scalars were forbidden at the root, `{}` would be enough as a no-op patch for object states. Patch composition still starts from `undefined`, because a summary patch may need to mean "no patch at all" independent of the eventual target type.

---

## Tricks

### A list of patches forms an ordered log.

Given a base state, an ordered list of patches can be replayed by folding `merge` over the list:

```
state = fold(merge, base, patches)
```

baerly-storage's current committed `U` log entries are full post-images, so the read path folds them by row set/delete. This section is about the sparse-patch algebra that explains update semantics and local coalescing.

---

### Log can be coalesced if the patches are structured

Coalescing means replacing an ordered patch window with one summary patch:

```
log_patch = fold(merge, undefined, patches)
```

That summary can be useful when a client works while disconnected and later reconnects: instead of transmitting every patch in the local window, it can transmit one summary patch.

The `undefined` accumulator is load-bearing. Folding `{x:null}` from `{}` would produce `{}` and lose deletion intent. Folding it from `undefined` preserves `{x:null}` as the summary patch.

Deletion is the boundary. Delete-free windows coalesce safely. A delete followed by a scalar or array replacement of the same key can also summarize safely. The unsafe case is delete-then-object-re-add, because an object patch re-adds fields by merging with the target that existed before the deleted subtree.

Counterexample: `s={x:{a:1,b:2}}`, `p1={x:null}`, `p2={x:{a:9}}`. Sequential replay gives `{x:{a:9}}` (`b` is gone), but coalescing with `merge(s, merge(p1,p2))` gives `{x:{a:9,b:2}}`. The field `b` resurrects because `merge(null,{a:9})` drops the deletion intent. Pure additive and scalar-overwrite patches coalesce safely; delete-then-object-re-add does not. RFC 7396 cannot encode delete-then-set-object in a single patch.

---

### Ordered Logs can be replayed multiple times

Replaying the _full ordered prefix from the same base state_ is idempotent. The key condition is the same base state: baerly-storage materializes a snapshot, then folds the ordered log range on top of that snapshot. Running that same materialization again gives the same view.

This is not the same as re-merging a coalesced patch onto an arbitrary downstream state. Coalesced patches still carry the delete caveat above.

[_Verification source code_](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L40)

---

### Ordered logs can repair speculative local gaps

Suppose a client optimistically folded the patches it had received while one entry was still missing. Replaying the complete ordered set can repair that local view.

```
fold(merge, base, [a, b, c]) =
	fold(merge, fold(merge, base, [a, c]), [b, c]) // we skipped b in first fold
```

This is useful for optimistic local views. It is not baerly-storage's recovery rule. A missing or malformed committed `log/<seq>.json` inside the trusted range `[log_seq_start, tail_hint)` (the dense half-open range defined by the [read algorithm](sync-protocol.md#read-algorithm)) is a protocol violation and surfaces as a `BaerlyError` (`Internal` for a missing entry, `InvalidResponse` for a malformed one), not something the kernel repairs by replay.

[_Verification source code_](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L146)

---

## JSON merge difference: `diff`

> **Not part of the baerly-storage kernel.** `diff` is not a
> baerly-storage API. For this helper surface, `@baerly/protocol`
> exports `merge`, not `diff`. This section uses the prior-art `mps3`
> implementation to name the _state-relative_ inverse of `merge`
> (`merge(a, diff(b, a)) == b`). Clients already send merge-patch
> documents; the writer never computes a diff.

If `merge` is the forward step `s_1 = merge(s_0, p)`, then `diff` asks for a patch that moves one known state to another known state. Given target state `b` and base state `a`, `diff(b, a)` produces a patch that moves `a` to `b`:

```
merge(a, diff(b, a)) == b
```

[_TypeScript implementation_](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/json.ts#L57)

---

### Identity is `undefined`

```
diff(a, undefined) = a
```

[_Verification source code_](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L146)

---

### `Diff(a, a) = undefined`

Diffing a doc with itself yields the identity patch.

[_Verification source code_](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L156)

---

### Diff is the inverse of merge

For a fixed base and target, the diff patch has this state-relative property:

```
diff(target, base) = patch <=> merge(base, patch) = target
```

That is the useful inverse here: not a patch inverse in isolation, but a patch computed relative to a known starting state.

[_Verification source code_](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L204)

---

## Structured JSON's Algebra: a Monoid Acting on States

Within the type-stable, delete-free subset, patches form a **monoid** under merge; the identity is `undefined`. Those patches act on states: applying a patch to a state yields a new state. There is no group because merge can destroy information, so a patch has no true two-sided inverse. For example, `{k:null}` does not invert `{k:1}`; apply both to `s={k:99}` and the result is `{}`, losing `99`. `diff` is state-relative, not a group inverse.

Plainly: this page's algebra explains when sparse patches can be summarized. baerly-storage's committed log does not depend on that shortcut. The kernel folds the **full ordered prefix from the snapshot base** over a totally ordered `seq` log of full post-images and deletes, never a patch-on-patch shortcut across a delete. The total log order is the source of correctness; sparse-patch coalescing is an optimization valid only inside the safe window.
