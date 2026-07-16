---
title: Causal-consistency property checking
audience: spec
doc_type: verification
summary: Low-complexity verification of causal consistency via a known global timeline.
last-reviewed: 2026-07-01
tags: [protocol, verification, property-testing]
related: [sync-protocol.md]
---

# Checking Causal Consistency with a Known Global Timeline

A basic message service sounds simple: send each recipient the messages in
the order they were written. The hard part starts when the product keeps
that same API while changing the path each message takes.

In this doc, a chat message stands in for an ordered write event in one
baerly-storage collection log.

- Multiplayer means merging queues from more than one participant.
- Optimistic updates give local writes a faster path than remote writes.
- Mobile-first clients need transparent resumption after unreliable
  connectivity.
- Local-first clients may buffer messages for days before reconnecting.

A reply should not arrive before the message it replies to. That expectation
is the shape of causal consistency.

Checking that expectation in a fully general distributed history is hard:
deciding causal consistency is
[NP-Complete](https://arxiv.org/abs/1611.00580#:~:text=Causal%20consistency%20is%20one%20of,according%20to%20their%20causal%20precedence.).
For randomized testing, we can use a cheaper check. The test harness records
one concrete execution order, then asks whether the causal constraints are
true in that known order. That avoids model-checker search.

The original MPS3 checker is implemented in 86 lines of TypeScript
([source](https://github.com/endpointservices/mps3/blob/12969b06c6564ac9df6c450f3d15a7ca3a5a9a25/src/__tests__/consistency.ts#L25))
and deliberately evaluates the generated boolean expression with `eval`.
baerly-storage keeps the same expression model in
`tests/fixtures/consistency.ts`; the backend-agnostic randomized cascade uses
an equivalent structural evaluator in `tests/fixtures/randomized-cascade.ts`
because Workerd disallows code generation from strings.

### Relevant Reading

"Time, Clocks, and the Ordering of Events in a Distributed System" by
Leslie Lamport is the foundational paper for the "happens-before" relation,
a way to talk about ordering when there is no single clock shared by every
participant.

[Causal Consistency - Jepsen blog](https://jepsen.io/consistency/models/causal#:~:text=Causal%20consistency%20captures%20the%20notion,order%20of%20causally%20independent%20operations.)

## Example

### Bob's Chat Window

```
Alice: Shall we invite Carol over?
<<Carol joins>>
Bob: Would you like to come over for dinner?
Carol: Yes! I'll bring dessert
```

### Carol's Chat Window

```
<<accepts invite>>
Bob: Would you like to come over for dinner?
Carol: Yes! I'll bring dessert
```

### Example of Causal Consistency Violation from Alice's Chat Window

```
Alice: Shall we invite Carol over?
<<Carol joins>>
Carol: Yes! I'll bring dessert
Bob: Would you like to come over for dinner?
```

Carol's answer only makes sense after Bob's question. The rest of this page
turns that ordering intuition into a small executable check.

## Causal Consistency

Causal consistency preserves the order of events when one event depends on
another. If event `Y` could only have happened after event `X`, we write that
dependency as \(X < Y\), read as "`X` happened before `Y`."

In the example, Carol first receives Bob's question. Then she writes a reply.
The reply exists **because** she saw the question, so the question event must
be ordered before the reply event:

```
BobQuestion < CarolReply
```

`BobQuestion` is the event that sent "Would you like to come over for
dinner?" `CarolReply` is the event that sent "Yes! I'll bring dessert."

Alice receives two messages from two different people. In general, she cannot
infer the true order of unrelated messages. Here she can, because one message
is plainly the reply to the other. If Alice sees the reply first, her own
timeline contains enough evidence to prove a causal violation.

The checker encodes these inferred dependencies as constraints and verifies
that they can all hold together. In these tests, the payload carries only
enough identity (`sender`, `send_time`) for the harness to reconstruct those
facts; that is test data, not a public API requirement.

### Causal Consistency Over Multiple Timelines

Each participant experiences events in an order. That order is the
participant's local history. A strictly serialized system would force every
participant to see the same history. A causally consistent system allows more
flexibility: participants can go offline, buffer work, and catch up later.
The rule it keeps is narrower. If one event "happened before" another, that
ordering must survive replay.

#### Principle 1: Consistency Within a Client's Timeline

There is not one required global history. There is one observed history per
client. Client A observes `A01 < A02 < A03...`; client B observes
`B01 < B02 < B03...`. A causally consistent interpretation is any way of
combining those timelines that preserves the known causal order:

```
A01 < B01 < B02 < A02 < A03 < B03
```

That interleaving is one valid interpretation because it preserves A's local
order and B's local order. Another interleaving may also be valid if it
preserves the same constraints.

#### Principle 2: Send Time Happens Before Receive Time

If client B, at time `B5`, observes client A broadcasting "I am at A3," then
B can deduce \(A3 < B5\). A message cannot be received before the sending
event it reports.

#### Principle 3: Observed message order

Within the centralised chat example, the checker assumes a single topic
order. Here, a topic corresponds to one collection log; the assumption does
not apply across baerly-storage collections. The simplified topic rule is:
if a client observes topic message `M` before topic message `N`, the checker
records that the send event for `M` happened before the send event for `N`:

```
send(M) < send(N)
```

This still allows local buffering and offline clients. The local
baerly-storage cascade uses the offline-first variant of the model: for each
receiver, the previously seen remote message is recorded before the next
observed source event. That preserves observed per-receiver order without
requiring one global order across all senders.

### Grounding

The useful trick is that `happened-before` behaves like `<` on a number line:
if `X < Y` and `Y < Z`, then `X < Z`. So a causal interpretation can be
checked by assigning a number to each event and asking whether every `<`
clause is true. This assignment is the grounding.

In the general setting, finding such an assignment requires symbolic search.
The system contract does not require a global history, but the randomized test
run has an instrumentation log that gives one concrete execution order.
Concretely, it can set `B1 = 1`, `C1 = 2`, `C2 = 3`, `A1 = 4`, and then
evaluate the collected inequalities directly. If any inequality is false
under that known order, the observed execution is not causally consistent.

## Live Annotation

The live checker appends each new implication as a `<` clause joined with
`&&`, then evaluates the grounded expression.

Legend:

- `P1` means client-local order.
- `P2` means send before receive.
- `P3` means observed topic order.
- `A0`, `B0`, and `C0` are the synthetic timeline starts.
- The leading number is the harness's global event number; `B1` means Bob's
  first local event; quoted `"B1"` is the message id being published or
  observed.

```
// Bob: Would you like to come over for dinner?
1 B1 publish("B1") =>

const A0 = 0, B0 = 0, C0 = 0, B1 = 1; // grounding
/*P1*/ B0 < B1                        // causal knowledge
> true
```

```
// Carol receives: Bob: Would you like to come over for dinner?
2 C1: observe ("B1") =>

const A0 = 0, B0 = 0, C0 = 0, B1 = 1, C1 = 2;
/*P1*/ B0 < B1 && // previous knowledge
/*P1*/ C0 < C1 && // Carol local step
/*P2*/ B1 < C1
> true
```

```
// Carol: Yes, I'll bring dessert
3 C2: publish ("C2") =>

const A0 = 0, B0 = 0, C0 = 0, B1 = 1, C1 = 2, C2 = 3;
/*P1*/ B0 < B1 &&
/*P1*/ C0 < C1 &&
/*P2*/ B1 < C1 &&
/*P1*/ C1 < C2 &&
/*P3*/ B1 < C1      // Bob's message reached Carol before her reply step
> true
```

```
// Alice receives: Yes! I'll bring dessert
4 A1: observe ("C2") =>

const A0 = 0, B0 = 0, C0 = 0, B1 = 1, C1 = 2, C2 = 3, A1 = 4;
/*P1*/ B0 < B1 &&
/*P1*/ C0 < C1 &&
/*P2*/ B1 < C1 &&
/*P1*/ C1 < C2 &&
/*P3*/ B1 < C1 &&
/*P1*/ A0 < A1 &&
/*P2*/ C2 < A1
> true
```

```
// Alice receives: Would you like to come over for dinner?
5 A2: observe ("B1") =>

const A0 = 0, B0 = 0, C0 = 0, B1 = 1, C1 = 2, C2 = 3, A1 = 4, A2 = 5;
/*P1*/ B0 < B1 &&
/*P1*/ C0 < C1 &&
/*P2*/ B1 < C1 &&
/*P1*/ C1 < C2 &&
/*P3*/ B1 < C1 &&
/*P1*/ A0 < A1 &&
/*P2*/ C2 < A1 &&
/*P1*/ A1 < A2 &&
/*P2*/ B1 < A2 &&
/*P3*/ C2 < B1    // conflict
> false // A causal violation!
```

The contradiction is now explicit. These three clauses cannot all be true:

```
/*P3*/ B1 < C1 // When Carol heard Bob
/*P1*/ C1 < C2 // Carol's sequential timeline
/*P3*/ C2 < B1 // When Alice received Bob's message after Carol's
```

## Session guarantees

The `P1`/`P2`/`P3` clauses above check causal ordering of *observed*
events. A document DB is also judged on three **session guarantees** that
the randomized cascade now asserts directly. Each names the backend class
it holds on and the assertion in `tests/fixtures/randomized-cascade.ts`
that witnesses it.

- **SG-1 — No-lost-writes (all backends).** Every `Writer.commit()` that
  returns success has its `log/<seq>` slot durably present in the
  collection log. `entry.seq` is that slot (the winning
  `If-None-Match: "*"` create). This holds even under fault injection: an
  acked commit is durable regardless of what the network does afterward.
  *Witness:* the drain-time containment check of the acked-slot set
  against the listed `log/<seq>` keys.

- **SG-2 — Read-your-writes (strongly-consistent backends).** After a
  writer's own `commit()` succeeds at slot `S`, that writer's next read
  resolves a slot `>= S`. Under last-write-wins a later slot may mask the
  value, but a writer never reads state older than its own committed
  write. *Witness:* the self-read assertion immediately after a successful
  commit, gated on `strongConsistency`.

- **SG-3 — Monotonic-reads (strongly-consistent backends).** Within one
  client, successive reads resolve non-decreasing `log/<seq>` slots — the
  log is append-only and entries are immutable, so the freshest matching
  slot only grows. *Witness:* the per-client last-observed-slot check in
  the poll loop, gated on `strongConsistency`.

SG-2 and SG-3 are gated to strongly-consistent backends (memory,
local-fs, in-process miniflare-R2) and are **not** asserted on the
node-minio variant, whose Toxiproxy fault injection deliberately induces
stale reads (see the `KNOWN FLAKE` note in the cascade driver). SG-1 is
backend-agnostic and runs everywhere.

Seeded replay: the cascade logs an integer `seed` at start and dumps the
observed schedule on any causal-consistency violation, so a failing
interleaving can be inspected and the injected entropy replayed by
passing the seed back. (Timer-driven interleaving remains wall-clock
dependent, so replay is not fully deterministic.)

## Conclusion

This framework drives randomized testing of baerly-storage's `Db` / `Writer`
commit path and storage adapters.

For one collection, baerly-storage chooses a single winning append order;
across collections, it does not. More precisely, collection reads and writes
are **linearizable** at the winning `log/<seq>` `If-None-Match: "*"` create
(see `docs/spec/sync-protocol.md`). Each public write is atomic per document.
**Cross-collection there is no ordering guarantee and multi-collection writes
are not atomic**: each write commits to exactly one collection log
(`docs/adr/001-tenant-cas-isolation.md`).

That makes this causal-consistency checker a cheap _lower-bound_ test. It can
witness violations of the weaker causal model; it is not trying to prove every
linearizability property. Layering even causal semantics over vanilla S3 is
hard enough to make that check valuable.

The original MPS3 checker immediately found a bug in one possible SDK
configuration: the no-versioning setting. The practical value is that the
check needs no extra dependencies and stays small enough to audit.

### Links

- The self-contained 86 LOC implementation of the causal model and checker ([source](https://github.com/endpointservices/mps3/blob/12969b06c6564ac9df6c450f3d15a7ca3a5a9a25/src/__tests__/consistency.ts#L25))
- Using the checker against the article's Alice, Bob and Carol example ([source](https://github.com/endpointservices/mps3/blob/12969b06c6564ac9df6c450f3d15a7ca3a5a9a25/src/__tests__/consistency.test.ts#L115))
- Using the checker to verify the consistency of the predecessor MPS3 SDK ([source](https://github.com/endpointservices/mps3/blob/12969b06c6564ac9df6c450f3d15a7ca3a5a9a25/src/__tests__/minio.test.ts#L350))
