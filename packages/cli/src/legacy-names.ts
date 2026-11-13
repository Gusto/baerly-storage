/**
 * Migration preflight for data an earlier release stored under names or
 * `_id`s that are not in Unicode Normalization Form C, or under names or
 * `_id`s with an unpaired UTF-16 surrogate. Pure; `admin fsck`
 * reports {@link nonNfcNames} and `admin dump` reports every helper.
 *
 * R2 stores canonically-equivalent keys as one object, so a non-NFC name
 * shares its key prefix with the NFC spelling there, and two rows whose
 * `_id`s are canonically equivalent ("twins") share index markers.
 */

/** A name role a bucket key interpolates. */
export type NameRole = "app" | "tenant" | "collection";

/** The roles whose name is not NFC, in `app`, `tenant`, `collection` order. */
export const nonNfcNames = (names: Readonly<Record<NameRole, string>>): NameRole[] =>
  (["app", "tenant", "collection"] as const).filter(
    (role) => names[role] !== names[role].normalize("NFC"),
  );

/**
 * The roles whose name holds an unpaired UTF-16 surrogate, in `app`,
 * `tenant`, `collection` order. `normalize("NFC")` leaves a lone
 * surrogate in place, so {@link nonNfcNames} never flags one.
 */
export const illFormedNames = (names: Readonly<Record<NameRole, string>>): NameRole[] =>
  (["app", "tenant", "collection"] as const).filter((role) => !names[role].isWellFormed());

/**
 * Non-NFC `_id`s, `_id`s with an unpaired UTF-16 surrogate, and groups of
 * `_id`s that share one NFC form.
 */
export interface LegacyIdReport {
  /** Every `_id` that is not NFC, sorted. */
  readonly non_nfc_ids: string[];
  /** Every `_id` with an unpaired UTF-16 surrogate (`!id.isWellFormed()`), sorted. */
  readonly ill_formed_ids: string[];
  /** Each group of two or more canonically-equivalent `_id`s, members sorted, groups sorted. */
  readonly twin_ids: string[][];
}

/** Classify a collection's live `_id`s for the migration preflight. */
export const legacyIdReport = (ids: Iterable<string>): LegacyIdReport => {
  const nonNfc: string[] = [];
  const illFormed: string[] = [];
  const byNfc = new Map<string, string[]>();
  for (const id of ids) {
    const nfc = id.normalize("NFC");
    if (nfc !== id) {
      nonNfc.push(id);
    }
    if (!id.isWellFormed()) {
      illFormed.push(id);
    }
    const group = byNfc.get(nfc);
    if (group === undefined) {
      byNfc.set(nfc, [id]);
    } else {
      group.push(id);
    }
  }
  const twins = [...byNfc.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.toSorted())
    // Groups are disjoint, so their first members never tie.
    .toSorted((a, b) => (a[0]! < b[0]! ? -1 : 1));
  return { non_nfc_ids: nonNfc.toSorted(), ill_formed_ids: illFormed.toSorted(), twin_ids: twins };
};

/**
 * Resolution text shared by the fsck finding and the dump warning.
 */
export const LEGACY_NAME_MIGRATION =
  "the SDK refuses non-NFC names; migrate legacy data with `baerly admin dump` then `baerly admin restore` under an NFC name that is not canonically equivalent to the original";

export const LEGACY_ID_MIGRATION =
  "before `baerly admin restore`, give each listed row a fresh NFC _id that is not canonically equivalent to any original";

export const LEGACY_ILL_FORMED_NAME_MIGRATION =
  "the SDK refuses names with an unpaired UTF-16 surrogate, and the CLI cannot pass one; with the code that wrote the data, still on a release that accepts the name, copy each row to a collection under a well-formed NFC name";

export const LEGACY_ILL_FORMED_ID_MIGRATION =
  "before `baerly admin restore`, give each listed row a well-formed _id (no unpaired UTF-16 surrogate)";
