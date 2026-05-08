
<p align="center" width="100%">
    <img width="50%" src="diagrams/sync_protocol_header.svg">
</p>

This is a focused explanation of the core sync protocol of MPS3. The sync protocol upgrades an S3 API into a causally consistent, multiplayer datastore without the use of intermediate servers.

## Why build over S3?

1. Minimalism. Why bother maintaining server-side code or a database when the bucket holding the website is a serviceable persistent state store. 

2. Curiosity. Is it even possible to build a database on the S3 API? This project demonstrates that yes it is.

3. Flexibility. Databases are one of the least portable parts of a stack. Decoupling storage from the database enables many more options like self-hosting with minio or using a specialist storage vendor that supports the S3 API.

## MPS3

MPS3 is a Key-Value store. The values are stored in versioned storage locations on S3. There is a layer of indirection that maps DB logical keys to storage locations hosted in a *manifest*

### Atomic Multi-key Operations

To enable consistent atomic updates of multiple keys, *first* the client writes the new values, and then it updates the *manifest*, not dissimilar to write-ahead-logging. Other clients use the manifest to access the DB, thus, because individual S3 file updates are atomic, writing a new manifest file is also an atomic operation that can flip the visibility multiple of key updates at once.

The manifest is a layer of *indirection* enabling bulk atomic operation (and more)

### Multiplayer Safe

Concurrent writes would conflict if all clients wrote to the *same* manifest location. There are no conditional writes in S3 so some updates would just be lost. To support multiplayer each client updates a *different* manifest entry ordered by time.

![manifests over time](diagrams/manifest.excalidraw.png)

The manifest records several major pieces of imperfect information.
- The time of the write, encoded in the key, as measured by the client. Client clocks are subject to clock skew so it might be a bit off.
- The operation that was applied, encoded a JSON merge patch to the DB state.
- The state of the database, but this also might be off because a client doesn't know what other writes are also in flight when written. But it's the client's best guess.

```
// manifest.json@01698260777020_53a_0001
{
    operation: { // Exact JSON-merge-PATCH representation of manifest operation
        keys: {
            "myBucket/oldKey": null, // DELETE
            "myBucket/myKey": {
                version: "2eefe4fb-c540-4482-abb7-f3dfedfc424d"
            }
        }
    },
    state: { // Approximation of current state
        keys: {
            "myBucket/myKey": {
                version: "2eefe4fb-c540-4482-abb7-f3dfedfc424d"
            }
        }
    },
}
```

Much of the engineering of the MPS3 sync protocol is about transforming that imperfect information into a causally consistent, atomic, multiplayer safe representation client-side.

### Reconciling concurrent writes

Note the client sends the operation as a [JSON_merge_patch](JSON_merge_patch.md). The database state at time *t* is the merge concatenation of all the operations up to *t* (see [a list of patches forms an ordered log](JSON_merge_patch.md#a-list-of-patches-forms-an-ordered-log))

$$state_t = \sum_{i=0}^{t} merge(patch_i)$$
Now it is inefficient for a client to replay the entire DB history. But we can use the [idempotency property of JSON-merge-patch](JSON_merge_patch.md#) to avoid it.

A client only needs to read an imperfect guess of the latest state, then replay all patches within a *lag* window to correct an estimate of the final state (see [Ordered Logs with missing entries can be repaired with replay](JSON_merge_patch.md#ordered-logs-with-missing-entries-can-be-repaired-with-replay))

$$\begin{eqnarray} 
state_t &=& state_{t-lag} + \sum_{i=lag}^{t} merge(patch_i) \\
&=& est_t + \sum_{i=lag}^{t} merge(patch_i)
\end{eqnarray}$$

So this is the key insight encoded within MPS3 manifest representation. The state field provides a good guess, but clients need to around "a bit" and reapply nearby operations to correct for inflight writes.

### Causal Consistency

If client's clocks are skewed, their manifest keys will not order between them correctly. This does not matter though! To preserve causal consistency, a specific client's writes must remain in the same order for all participants. Clock skew translates, but does not reorder, operations in time, so causal consistency is not undermined.

The sync protocol is eager, exposing all operations as soon as they are visible, so clock skew does not affect end-to-end latency either. The only effect is on ordering within the log which can be observed when writing to the same key. Delayed clients will appear to be affecting the database in the past, which means their operations are more easily masked by other clients.

See [Checking Causal Consistency the Easy Way](causal_consistency_checking.md) describing the randomized property checking used for validating causal consistency.

### Mitigating Large clock skew

Clock skew becomes a consistency-threatening problem if exceeding the *lag* window. Then the reconciliation algorithm will not be looking far enough back and will miss operations. Client clocks cannot be trusted. 

Large clock skew is detected by MPS3 by comparing the manifest key timestamp against the server-provided `LastModified` time. If the skew is above a *stale* write threshold it is ignored. As long as the *stale* write threshold is sufficiently below the *lag* parameter, all clients will converge to the same state regardless of clock skew.

### Automatic Clock Adjustment

In addition, clients use the `Date` header to continuously correct their clocks, so clients with heavily skewed clocks can be corrected reactively and continuously and thus capable of joining the log.

### Subtleties of the manifest key

The manifest key is primarily time-ordered, but some extra information is needed to fix edge cases such as: writing on the exact same millisecond or using a sub-millisecond S3 API (such as local-first). So the manifest key format is actually

```
<TIMESTAMP>_<SESSION>_<COUNTER>
```

Furthermore, because S3's `list-objects-v2` operation can only query in ascending lexicographical order, and its more efficient for the algorithm to look backward in descending order, both the timestamp and counter elements are encoded with a reverse lexicographically ordered string. Key length is a limited resource, so we use a Javascript's native base-32 string representation, padded and subtracted from the max value to reverse the directions

```js
export const uint2strDesc = (num: number, bits: number): string => {
  const maxValue = Math.pow(2, bits) - 1;
  return uint2str(maxValue - num, bits);
};

const uint2str = (num: number, bits: number) => {
  const maxBase32Length = Math.ceil(bits / 5);
  const base32Representation = num.toString(32);
  return base32Representation.padStart(maxBase32Length, "0");
};
```

### Minimising list-object-v2 calls

List API calls are costly on S3, they are charged at the same rate as PUTs which are 10x more expensive than GETs. As the subscription features of MPS3 rely on polling, we want to avoid having the list-object-v2 API calls being the hot end of a poll loop. 

So after writing a new manifest entry, the client then touches a `last_change` file. Clients with active subscriptions poll this file, and only if the content changes (efficiently detected with `If-None-Match` header), does the algorithm proceed to syncing the latest state via the `list-object-v2` API call.

For APIs where listing is cheap (e.g. local-first/IndexDB), this optimization can be disabled by the `minimizeListObjectsCalls` flag to `false`. 

## The Sync Algorithm

1. Poll the `last_change` file using `If-None-Match` headers, if it hasn't changed go no further
	- [syncer.ts#L101](https://github.com/endpointservices/mps3/blob/fb052d712ed12e89a37cce0113b89d07c706c502/src/syncer.ts#L101)
2. List objects backward in time from the `now + lag` timestamp
	-  [syncer.ts#L116](https://github.com/endpointservices/mps3/blob/fb052d712ed12e89a37cce0113b89d07c706c502/src/syncer.ts#L116)
3. Exclude entries whose `abs(timestamp - LastModified) > stale` because they were created by a client with significant clock skew
	-  [syncer.ts#L125](https://github.com/endpointservices/mps3/blob/fb052d712ed12e89a37cce0113b89d07c706c502/src/syncer.ts#L125)
4. Let the first entry encountered be `latest_state`
	-  [syncer.ts#L159](https://github.com/endpointservices/mps3/blob/fb052d712ed12e89a37cce0113b89d07c706c502/src/syncer.ts#L159)
5. json-merge-patch all `operations` with `operations.timestamp - lag > latest_state.timestamp` in order into  `latest_state`
	- [syncer.ts#L200](https://github.com/endpointservices/mps3/blob/fb052d712ed12e89a37cce0113b89d07c706c502/src/syncer.ts#L200)
6. garbage collect entries with `timestamp - lag < latest_state`
	- [syncer.ts#L177](https://github.com/endpointservices/mps3/blob/fb052d712ed12e89a37cce0113b89d07c706c502/src/)
7. notify subscribers of changes
	-  [manifest.ts#L111](https://github.com/endpointservices/mps3/blob/fb052d712ed12e89a37cce0113b89d07c706c502/src/manifest.ts#L111)

### Summary

The algorithm is deceptively simple in implementation but leans heavily on the algebraic property of JSON-merge-patch and wiggle room in causal consistency to accommodate client-side clock_skew. The same algorithm is used also to synchronize state transfer between tabs in the local-first setting. By designing for a relatively small set of underlying S3 semantics, it is easy to apply the sync protocol to other, more expressive storage systems.