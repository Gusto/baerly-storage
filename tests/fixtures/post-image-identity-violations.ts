/**
 * Insert/update post-images whose `_id` does not name the `doc_id` they are
 * filed under, one per identity failure the format contract rules out
 * (§"Chunk wire": `after._id === doc_id`). Every `docId` is inside the
 * `utf8-scalar-v1` domain, so a consumer that rejects these is rejecting the
 * identity, not the ID.
 *
 * `postImageIdentityAdmissible` holds the matching accept cases.
 *
 * `after` is a factory because some shapes (an accessor `_id`) must not be
 * shared or observed between cases.
 */
export interface PostImageIdentityCase {
  readonly name: string;
  readonly docId: string;
  readonly after: () => unknown;
}

class IdentifiedRow {
  readonly _id: string;
  constructor(id: string) {
    this._id = id;
  }
}

export const postImageIdentityViolations: readonly PostImageIdentityCase[] = [
  { name: "_id missing", docId: "a", after: () => ({ value: 1 }) },
  { name: "_id a number", docId: "a", after: () => ({ _id: 1, value: 1 }) },
  { name: "_id null", docId: "a", after: () => ({ _id: null, value: 1 }) },
  {
    name: "_id an accessor",
    docId: "a",
    after: () => Object.defineProperty({ value: 1 }, "_id", { get: () => "a", enumerable: true }),
  },
  {
    name: "_id inherited from a non-plain prototype",
    docId: "a",
    after: () => Object.assign(Object.create({ _id: "a" }), { value: 1 }),
  },
  {
    name: "_id a non-enumerable own property",
    docId: "a",
    after: () => Object.defineProperty({ value: 1 }, "_id", { value: "a", enumerable: false }),
  },
  { name: "_id -0", docId: "a", after: () => ({ _id: -0 }) },
  { name: "_id NaN", docId: "a", after: () => ({ _id: Number.NaN }) },
  { name: "_id a boxed String", docId: "a", after: () => ({ _id: new String("a") }) },
  { name: "after null", docId: "a", after: () => null },
  { name: "after a string", docId: "a", after: () => "a" },
  {
    name: "after an array with an own _id",
    docId: "a",
    after: () => Object.assign([], { _id: "a" }),
  },
  {
    name: "after a null-prototype array with an own _id",
    docId: "a",
    after: () => Object.setPrototypeOf(Object.assign([], { _id: "a" }), null),
  },
  {
    name: "after a null-prototype function with an own _id",
    docId: "a",
    after: () =>
      Object.setPrototypeOf(
        Object.assign(() => 0, { _id: "a" }),
        null,
      ),
  },
  {
    name: "after a Date with an own _id",
    docId: "a",
    after: () => Object.assign(new Date(0), { _id: "a" }),
  },
  {
    name: "after a class instance with an own _id",
    docId: "a",
    after: () => new IdentifiedRow("a"),
  },
  { name: "_id the NFD spelling of an NFC doc_id", docId: "é", after: () => ({ _id: "é" }) },
  { name: "_id the NFC spelling of an NFD doc_id", docId: "é", after: () => ({ _id: "é" }) },
  { name: "_id differing by case", docId: "a", after: () => ({ _id: "A" }) },
  { name: "_id a proper prefix of doc_id", docId: "ab", after: () => ({ _id: "a" }) },
  { name: "doc_id a proper prefix of _id", docId: "a", after: () => ({ _id: "ab" }) },
  // A different valid ID: the silent re-key when the owning descriptor's
  // range can absorb it, and a cross-descriptor overlap when it cannot.
  { name: "_id another ID in the same descriptor", docId: "m", after: () => ({ _id: "mm" }) },
  { name: "_id another ID past the next descriptor", docId: "m", after: () => ({ _id: "zz" }) },
];

/**
 * Post-images that satisfy the identity rule in shapes a stricter-than-
 * contract check would wrongly reject. A consumer must accept these.
 */
export const postImageIdentityAdmissible: readonly PostImageIdentityCase[] = [
  {
    name: "a null-prototype post-image",
    docId: "a",
    after: () => Object.assign(Object.create(null), { _id: "a", value: 99 }),
  },
  { name: "a frozen post-image", docId: "a", after: () => Object.freeze({ _id: "a", value: 99 }) },
];
