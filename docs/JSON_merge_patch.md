# JSON Merge Patch: Algebra and Applications

JSON Merge patch is a [standardized](https://datatracker.ietf.org/doc/html/rfc7386) way to encode *sparse* updates to a JSON document. It has some nice properties that make it useful in collaborative applications.
In this article, we cover the basics, its algebraic properties, it's inverse and some tricks, cross references with source code links.

We will discover that to unlock the full potential of JSON-merge-Patch, you should avoid mixing types. The set of `structured JSONs`` form an algebraic group over merge. With structured JSON it is safe to use JSON-merge-PATCH to coalesce writes, a useful optimization for network optimization.

- [Intro](#intro)
	- [Patches move the state forward](#patches-move-the-state-forward)
	- [Arrays and null values don't work](#arrays-and-null-values-dont-work)
	- [Comparison to JSON Patch (RFC 6902)](#comparison-to-json-patch-rfc-6902)
- [Properties of JSON-merge-patch](#properties-of-json-merge-patch)
	- [Merges are not associative in general](#merges-are-not-associative-in-general)
	- [Merges are associative for structured documents](#merges-are-associative-for-structured-documents)
	- [Non-overlapping patches are commutative.](#non-overlapping-patches-are-commutative)
	- [Overlapping writes are last-write-wins](#overlapping-writes-are-last-write-wins)
	- [Merges are idempotent](#merges-are-idempotent)
	- [The identity patch is `undefined`](#the-identity-patch-is-undefined)
	- [The identity patch is not  `{}`](#the-identity-patch-is-not--)
- [Tricks](#tricks)
	- [A list of patches forms an ordered log.](#a-list-of-patches-forms-an-ordered-log)
	- [Log can be coalesced if the patches are structured](#log-can-be-coalesced-if-the-patches-are-structured)
	- [Ordered Logs can be replayed multiple times](#ordered-logs-can-be-replayed-multiple-times)
	- [Ordered Logs with missing entries can be repaired with replay](#ordered-logs-with-missing-entries-can-be-repaired-with-replay)
- [JSON merge difference: `diff`](#json-merge-difference-diff)
	- [Identity is `undefined`](#identity-is-undefined)
	- [`Diff(a, a) = undefined`](#diffa-a--undefined)
	- [Diff is the inverse of merge](#diff-is-the-inverse-of-merge)
- [Structured JSON's Algebraic Group](#structured-jsons-algebraic-group)

---

## Intro

Given a document

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

We can surgically delete the nested field `nested.d` with a patch using `null` as the value

```
{
	nested: {
		d: null
	}	
}
```

And we can add fields using values 

```
{
	nested: {
		new: "value"
	}
}
```

We can do multiple add, remove, and delete operations all at once, at all levels of the hierarchy with RFC 7386 JSON merge patches:

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

If you view a JSON document as the state of a system, then patching can be seen as updating the state. As patches are small, the state can be large, and only the small *delta update* merge patch needs to be transmitted.

```
state_t+1 = merge(state_t, patch_t)
```

[*Typescript implementation*](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/json.ts#L21)

---

### Arrays and null values don't work

Merge patches have a huge disadvantage in that they only really work well with dictionaries. Furthermore, because `null` is used to represent delete, it is impossible to use `null` as a value. You *can* use arrays, but they are not merged efficiently, and thus array mutations tend to conflict more frequently.

---

### Comparison to JSON Patch (RFC 6902)

There is a cousin standard called `JSON Patch` ([RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902)) that attempts to update a state by applying a sequence of operations.
```
[
 { "op": "add", "path": "/baz", "value": "qux" },
 { "op": ...}
]
```

The is more expressive, it can represent null values and can also express insertion into an array. However, it is more complex and imperative. It does not have as many nice algebraic properties as `JSON-merge-patch` discussed below and thus in my subjective opinion, it is ugly and should be avoided. 

`JSON-merge-patch` is functional and elegant, but restricts you to non-null values and dictionaries. `JSON patch` is applicable in more situations but clunky. I suspect that `JSON-merge-patch`'s constraints force better schema design, smaller code, and fewer edge cases and therefore better suited to high-performance code.

---

## Properties of JSON-merge-patch

### Merges are not associative in general

An associative binary function can be grouped in any way on a sequence and yield the same result. This is a useful property as it allows you to compact expressions whenever adjacent elements are known.

```
merge(merge(a, b), c) == merge(a, merge(b, c)) // NOT TRUE IN GENERAL
```

It does not work for merges when objects and scalars are mixed
```
merge(merge(0, {}), 0) = 0
!==
merge(0, merge({}, 0)) = {}
```

---

### Merges are associative for structured documents

If we add the constraint that you are not allowed to change the type of elements then `merge` *is* associative. 

```
merge(merge(a, b), c) == merge(a, merge(b, c)) for structured docs
```

JSON generated from a typed model doesn't normally change types. This constraint is not a big deal, but it is something to watch out for.

Associativity is a useful property in networked for write coalescing. We can exploit associativity by merging a list of patches into a single large patch before transmission, potentially reducing bandwidth and increasing efficiency.

[*Verification source code*](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L123)

---

### Non-overlapping patches are commutative. 

If two patches manipulate different parts of the document, they can be applied in either order and get the same result.

```
merge(merge(s, a), b) == merge(merge(s, b), a) if b intersect a == empty
```

This is useful for collaboration, sparse updates from different players can be merged nicely, and in most cases, if the players are doing different things the outcome will not be affected by network delays. 

---

### Overlapping writes are last-write-wins

There is, however, a problem when players mutate the same resource, for example, if player one deletes a resource
```
{
	resource1: null
}
```
and another updates the same resource
```
{
	resource1: "new value"
}
```

Then if the patches are applied DELETE, UPDATE, the final state of resource1 is `new value`. If the patches are applied UPDATE, DELETE, the final state of resource1 is `null` i.e. DELETED. In this case, the operations do not commute. Thus the conflict resolution for overlapping or conflicting merges is last-write-wins.

---

### Merges are idempotent

If you apply the same patch twice, the result is the same

```
merge(merge(s, a), a) = merge(s, a)
// and
merge(a, a) = a
```

This is useful for making network communication fault-tolerant to network disconnects. It is safe to retry if they are unsure that the server received the update, as applying the same update twice is safe.

[*Verification source code*](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L133)

---

### The identity patch is `undefined`

Patching anything with `undefined` results in the same value

```
merge(x, undefined) = x
```

It's an annoying detail that you need an extra symbol to represent "not set" for the root element of a JSON document. JSON docs on the wire don't have a literal for this, but for nested fields, you have a similar degree of freedom by omitting the definition of the field. So in practice, we do not need additional symbols in the wire representation. The extra symbol is useful as a transient value for implementation as it simplifies some of the recursion.

[*Verification source code*](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L81)

---

### The identity patch is not  `{}` 

Patching with the empty object does not modify objects

```
merge({a:""}, {}) = {a:""}
```

so it seems like a better candidate for the identity patch. However, if the target is a scalar it overwrites it with `{}`. 

```
merge(0, {}) = {} // not 0 unfortunately
```

Thus, `{}` is not the identity patch. If we forbid scalars at the root it would be, and we would not need the extra symbol `undefined` for the identity.

---

## Tricks
### A list of patches forms an ordered log.

You can think of a merge operation as an addition. You can concatenate merges from the identity to array as a fold/reduce over the set of 

```
state = sum_merge_over_patches p
// or
state = fold({}, patches)
```

---

### Log can be coalesced if the patches are structured

If your patches are structured documents, you can apply them all to form a compact summary.

```
log_patch = sum_merge p
```

This is useful for write **coalescing**. For example, if you allow one part of the system to continue to work while being disconnected, when it regains connectivity you can coalesce the log and transmit just a single big patch.

---

### Ordered Logs can be replayed multiple times

Because patches are idempotent, you can apply the same set of patches multiple times.

```
fold(patches) = fold(fold(patches)), patches)
```

[*Verification source code*](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L40)

---

### Ordered Logs with missing entries can be repaired with replay

If you use a log with a missing entry to generate a final state, that final state can be repaired by replaying the full log.

```
fold(a, b, c) = fold(fold(a, c), b, c) // we skipped b in first fold
```

This is useful for optimistic updates. You can apply all ordered entries as soon as you receive them, but if some are received out of some global order, you can fix the state without much bookkeeping.

[*Verification source code*](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L146)

---

## JSON merge difference: `diff`

If we think of merge as like addition, `s_1 = s_0 + p` there exists a subtraction `s_1 - s_0` to calculate the patch between two states. Thus, merging the difference between `b` and `a` generates a patch that can move `a` to `b`:-

```
merge(a, diff(b, a)) == b
```

[*Typescript implementation*](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/json.ts#L57)

---

### Identity is `undefined`

```
diff(a, undefined) = a
```

[*Verification source code*](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L146)

---

### `Diff(a, a) = undefined`

Diffing a doc with itself yields the identity patch.

[*Verification source code*](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L156)

---

### Diff is the inverse of merge

This applies to any JSON document

```
diff(a, b) = c <=> merge(b, c) = a
```

Now there is a precise and unique inverse of merge, we can understand merge better.

[*Verification source code*](https://github.com/endpointservices/mps3/blob/ce5a622c730466d336d761f39b5572224f2dd259/src/__tests__/json.test.ts#L204)

---

## Structured JSON's Algebraic Group

Structured JSON documents form an algebraic group over merges. They adhere to properties of associativity, identity, closure, and inverseness. However, this only holds when documents maintain a stable schema, ensuring that scalar values and objects remain consistent.

By keeping structured documents, you can safely do write coalescing by merging pending operations in a queue. When you do this you exploit the associativity property. 
Even if you do not use structured operation, JSON-merge-patch always has a well-defined inverse.

JSON-merge-patch rocks!
