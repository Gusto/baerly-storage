# Checking Causal Consistency the Easy Way

Message infrastructure has fairly clear semantics: "send the messages to the recipients in the order they were written".
And yet, things start to get complicated as advanced features are added.

- Multiplayer? well now you have to consider merging queues and multiple timelines
- Optimistic updates? Well now, local writes have a different pathway.
- Mobile-first? Well clients connectivity is unreliable, so you need transparent resumption
- Local-first? Well now some participants messages are buffered and delayed for days

Still, there is an intuitive notion of ordering that is preserved even under these use cases: causal consistency.
Most advanced features are transparent to the messaging user. They use the same SDK, but the path of the messages through the system changes. So you need a way to 
verify the API semantics are observably correct just from SDK usage experiments.


Verifying causal consistency is quite tricky in general ([NP-Complete](https://arxiv.org/abs/1611.00580#:~:text=Causal%20consistency%20is%20one%20of,according%20to%20their%20causal%20precedence.) in fact!), but I consider randomized property checking central to building a robust infrastructure. Here I explain a low complexity technique for verifying causal consistency, that avoids complex model checking. Its implemented in < 100 lines of Typescript ([source](https://github.com/endpointservices/mps3/blob/12969b06c6564ac9df6c450f3d15a7ca3a5a9a25/src/__tests__/consistency.ts#L25)) and uses `eval` legitimately! We avoid any searching by exploiting the known global timeline.

### Relevant Reading

"Time, Clocks, and the Ordering of Events in a Distributed System" by Leslie Lamport, the foundational paper of causal consistency that introduced the relation "happens-before" is a way that scales to multiple timelines. Its not the easiest introduction, but basically all knowledge required is there.

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

We can intuitively spot a causal violation in Carol answering Bob's question before it was asked. Logically it doesn't make sense to answer a question before it was asked, but what is really going on here formally?

## Causal Consistency

Causal consistency is defined as ensuring that event X happens before event Y, denoted as \(X < Y\).

From Carol's perspective, she received a question from Bob as incoming information from the chat app. She then wrote a reply in the chat application. She only wrote that reply **because** she was asked the question. Thus, a causal ordering (`<`) is established between these two events:

```
"Bob: Would you like to come over for dinner? < Carol: Yes! I'll bring dessert"
```

In Alice's chat window, she expects to receive messages preserving causal ordering. She is notified of two messages sent by two different people. In general, she can't tell if the messages are out of order, but in this specific case, the messages have inferable causal ordering because one is clearly the reply to the other. Thus, Alice can tell just from her own timeline that causal consistency has been violated.

By encoding causal ordering dependency information into the messages themselves, we can verify causality has not been violated without complex model checking.

### Causal Consistency Over Multiple Timelines

Each participant (client) experiences events in an order. This is their personal history. In a strictly serialized system, this history would need to appear the same for all participants. But in a causally consistent system, participants can go offline and catch up later. The main guarantee in causally consistent systems is that things that "happened before" other things are preserved when replaying history, e.g., when getting back online.

#### Principle 1: Consistency Within a Client's Timeline

So there is not a single global history in a causally consistent system; there is an observed history for each client. We can say client A observes events at `A01 < A02 < A03...`, and client B observes events on its own timeline of steps `B01 < B02 < B03...`. For a system to be causally consistent, there must be a combination of timelines that preserve causal ordering:

```
A01 <              < A02 < A03
       B01 < B02                < B03
```

#### Principle 2: Send time happens before receive time

If client B, at time B5, observes client A broadcasting "I am at A3," it can deduce \( A3 < B5 \) (A3 happened-before B5). 

#### Principle 3: Global Ordering of Messages in Topic

Within shared topics, like chat, you want everybody to receive the messages in the same order. A centralised system also fits this definition. A received message occurs after
the previously received message for all given client. 

```
previous_message < received_message 
```

Note this does not preclude clients locally buffering messages or going offline, it just implies there is a global ordering that every message eventually passes through.

### Grounding 

Usefully the causal "happens-before" relation works similarly to the Javascript's less-than does on the number line. So finding a causally consistent interpretation is equivalent to assigning numbers that satisfy the numerical inequalities (grounding).

In a general setting this involves a exhaustive symbolic searching, but if we know the 
global order of events, then we can simply set the temporal variables to their known global values.

## Live Annotation

We can append causal implications (expressed as `<` and `&&`) as we observe a live system exchanging messages. Here's the salient part of our chat example. It is then enough to evaluate the expressions as Javascript using `eval` to check for validity.

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
/*P1*/ C0 < C1 && // new stuff
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
/*P3*/ B1 < C1      // Note Carol's response depends on Bob
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
5 A2: observe ("B2") => 

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
/*P3*/ C2 < B1    // Eeek
> false // A causal violation!
```

The clauses that conflict are

```
/*P3*/ B1 < C1 // When carol heard bob
/*P1*/ C1 < C2 // Carol's sequential timeline
/*P3*/ C2 < B1 // When alice received bobs message after carols
```

## Conclusion

We use this framework for randomized testing of the MPS3 client so we can test for causal consistency. Causal consistency is the true contract we want to offer over multiple concurrent clients. Layering causal consistency semantics over vanilla S3 is not easy, so we need to go the extra mile to check the complexity is achieving what we hoped for. 

In fact, the checker immediately found a bug with one of the possible configurations of the clients (the no versioning setting). I am very pleased this could be implemented with no additional dependencies in pure Javascript with very little code.

The next obvious step is to generalize the system to handle clients joining and leaving multiple independent ordered topics. This article was
written as a basic introduction to the technique that we will build upon during future development of MPS3.


### Links

- The self contained 86 LOC implementation of the causal model and checker ([source](https://github.com/endpointservices/mps3/blob/12969b06c6564ac9df6c450f3d15a7ca3a5a9a25/src/__tests__/consistency.ts#L25))
- Using the checker against the article's Alice, Bob and Carol example ([source](https://github.com/endpointservices/mps3/blob/12969b06c6564ac9df6c450f3d15a7ca3a5a9a25/src/__tests__/consistency.test.ts#L115))
- Using the checker to verify the consistency of the MPS3 SDK ([source](https://github.com/endpointservices/mps3/blob/12969b06c6564ac9df6c450f3d15a7ca3a5a9a25/src/__tests__/minio.test.ts#L350))
