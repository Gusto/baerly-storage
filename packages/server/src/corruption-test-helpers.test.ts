import { describe, expect, test } from "vitest";
import {
  corruptNumber,
  corruptUtf8,
  duplicateBytes,
  flipByte,
  insertByte,
  swapBytes,
  truncateBytes,
} from "./corruption-test-helpers.ts";

describe("truncateBytes", () => {
  test("returns a truncated copy without mutating the input", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const truncated = truncateBytes(original, 3);
    expect(truncated).toEqual(new Uint8Array([1, 2, 3]));
    expect(original).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(truncated).not.toBe(original);
  });

  test("returns all bytes when at exceeds length", () => {
    expect(truncateBytes(new Uint8Array([1, 2, 3]), 10)).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("flipByte", () => {
  test("flips bit 0 at the given position without mutating the input", () => {
    const original = new Uint8Array([0b0000_0000, 0b1111_1111]);
    expect(flipByte(original, 0)).toEqual(new Uint8Array([0b0000_0001, 0b1111_1111]));
    expect(flipByte(original, 1)).toEqual(new Uint8Array([0b0000_0000, 0b1111_1110]));
    expect(original).toEqual(new Uint8Array([0b0000_0000, 0b1111_1111]));
  });
});

describe("insertByte", () => {
  test("inserts a byte at the given position without mutating the input", () => {
    const original = new Uint8Array([1, 2, 3]);
    const inserted = insertByte(original, 1, 99);
    expect(inserted).toEqual(new Uint8Array([1, 99, 2, 3]));
    expect(original).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("inserts at the start and end", () => {
    const original = new Uint8Array([1, 2, 3]);
    expect(insertByte(original, 0, 9)).toEqual(new Uint8Array([9, 1, 2, 3]));
    expect(insertByte(original, 3, 9)).toEqual(new Uint8Array([1, 2, 3, 9]));
  });
});

describe("duplicateBytes", () => {
  test("duplicates a slice in place without mutating the input", () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const duplicated = duplicateBytes(original, 1, 2);
    expect(duplicated).toEqual(new Uint8Array([1, 2, 3, 2, 3, 4]));
    expect(original).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe("swapBytes", () => {
  test("swaps two positions without mutating positions in between", () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    expect(swapBytes(original, 0, 3)).toEqual(new Uint8Array([4, 2, 3, 1]));
    expect(swapBytes(original, 1, 2)).toEqual(new Uint8Array([1, 3, 2, 4]));
    expect(original).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe("corruptUtf8", () => {
  test("corrupts a multi-byte UTF-8 sequence's lead byte", () => {
    const original = new TextEncoder().encode("é"); // 0xC3 0xA9
    const corrupted = corruptUtf8(original, 0);
    expect(corrupted.length).toBe(2);
    expect(corrupted[0]).not.toBe(0xc3);
    expect(corrupted[1]).toBe(0xa9);
    expect(original).toEqual(new TextEncoder().encode("é"));
  });

  test("returns bytes unchanged for ASCII-only input", () => {
    const original = new TextEncoder().encode("abc");
    expect(corruptUtf8(original, 0)).toEqual(original);
  });
});

describe("corruptNumber", () => {
  test("flips the low bit of the first digit found", () => {
    const original = new TextEncoder().encode('{"value":123}');
    const corrupted = corruptNumber(original, 0);
    const text = new TextDecoder().decode(corrupted);
    expect(text).toBe('{"value":023}');
  });

  test("returns bytes unchanged when there are no digits", () => {
    const original = new TextEncoder().encode('{"key":"abc"}');
    expect(corruptNumber(original, 0)).toEqual(original);
  });
});
