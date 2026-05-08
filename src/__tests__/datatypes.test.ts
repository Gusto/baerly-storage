import { uint2str, str2uint, uint2strDesc, str2uintDesc } from "../types";
import { expect, describe, it } from "bun:test";

describe("datatypes", () => {
  describe("uint2str", () => {
    it("should correctly convert for uint8", () => {
      expect(uint2str(15, 8)).toBe("0f");
      expect(uint2str(255, 8)).toBe("7v");
    });

    it("should correctly convert for uint16", () => {
      expect(uint2str(255, 16)).toBe("007v");
      expect(uint2str(65535, 16)).toBe("1vvv");
    });

    it("should correctly convert for uint10", () => {
      expect(uint2str(0, 9)).toBe("00");
      expect(uint2str(255, 9)).toBe("7v");
      expect(uint2str(511, 9)).toBe("fv");
    });
  });

  describe("str2uint", () => {
    it("should correctly convert for uint8", () => {
      expect(str2uint("0f")).toBe(15);
      expect(str2uint("ff")).toBe(495);
    });

    it("should correctly convert for uint16", () => {
      expect(str2uint("00ff")).toBe(495);
      expect(str2uint("ffff")).toBe(507375);
    });

    it("should correctly convert for uint9", () => {
      expect(str2uint("000")).toBe(0);
      expect(str2uint("0ff")).toBe(495);
      expect(str2uint("1ff")).toBe(1519);
    });
  });

  describe("lexicographical ordering", () => {
    it("should preserve order for uintX", () => {
      [1, 3, 8, 10, 16].forEach((bits) => {
        for (let i = 1; i < Math.pow(2, bits); i++) {
          expect(uint2str(i - 1, bits) < uint2str(i, bits)).toBe(true);
        }
      });
    });
  });

  describe("uint2strDesc", () => {
    it("should produce reversed lexicographical order for uintX", () => {
      [1, 3, 8, 10, 16].forEach((bits) => {
        for (let i = 1; i < Math.pow(2, bits); i++) {
          expect(uint2strDesc(i - 1, bits) < uint2strDesc(i, bits)).toBe(false);
        }
      });
    });
  });

  describe("str2uintDesc", () => {
    it("should be the inverse of uint2strDesc for uintX", () => {
      [1, 3, 8, 10, 16].forEach((bits) => {
        for (let i = 1; i < Math.pow(2, bits); i++) {
          expect(str2uintDesc(uint2strDesc(i, bits), bits)).toBe(i);
        }
      });
    });
  });
});
