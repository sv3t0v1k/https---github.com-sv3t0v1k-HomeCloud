import { parseRangeHeader } from "./sharing.controller";

describe("parseRangeHeader", () => {
  const SIZE = 16; // "0123456789ABCDEF"

  describe("no range / 200 path", () => {
    it("undefined header -> none (200, full)", () => {
      expect(parseRangeHeader(undefined, SIZE)).toEqual({ type: "none" });
    });
    it("empty header -> none", () => {
      expect(parseRangeHeader("", SIZE)).toEqual({ type: "none" });
    });
    it("whitespace-only header -> none", () => {
      expect(parseRangeHeader("   ", SIZE)).toEqual({ type: "none" });
    });
  });

  describe("valid ranges -> range", () => {
    it("bytes=0-3 -> first 4 bytes", () => {
      expect(parseRangeHeader("bytes=0-3", SIZE)).toEqual({
        type: "range",
        start: 0,
        end: 3,
      });
    });
    it("bytes=12-15 -> last 4 bytes", () => {
      expect(parseRangeHeader("bytes=12-15", SIZE)).toEqual({
        type: "range",
        start: 12,
        end: 15,
      });
    });
    it("bytes=0-0 -> single first byte", () => {
      expect(parseRangeHeader("bytes=0-0", SIZE)).toEqual({
        type: "range",
        start: 0,
        end: 0,
      });
    });
    it("bytes=15-15 -> single last byte", () => {
      expect(parseRangeHeader("bytes=15-15", SIZE)).toEqual({
        type: "range",
        start: 15,
        end: 15,
      });
    });
    it("bytes=0-15 -> full range", () => {
      expect(parseRangeHeader("bytes=0-15", SIZE)).toEqual({
        type: "range",
        start: 0,
        end: 15,
      });
    });
    it("bytes=0- -> open-ended from start", () => {
      expect(parseRangeHeader("bytes=0-", SIZE)).toEqual({
        type: "range",
        start: 0,
        end: 15,
      });
    });
    it("bytes=5- (open-ended) -> start to EOF", () => {
      expect(parseRangeHeader("bytes=5-", SIZE)).toEqual({
        type: "range",
        start: 5,
        end: 15,
      });
    });
    it("bytes=-4 -> suffix (last 4)", () => {
      expect(parseRangeHeader("bytes=-4", SIZE)).toEqual({
        type: "range",
        start: 12,
        end: 15,
      });
    });
    it("bytes=-1 -> suffix (last 1 byte)", () => {
      expect(parseRangeHeader("bytes=-1", SIZE)).toEqual({
        type: "range",
        start: 15,
        end: 15,
      });
    });
    it("bytes=-20 when suffix >= size -> whole file", () => {
      expect(parseRangeHeader("bytes=-20", SIZE)).toEqual({
        type: "range",
        start: 0,
        end: 15,
      });
    });
    it("bytes=0-100 -> end clamped to EOF", () => {
      expect(parseRangeHeader("bytes=0-100", SIZE)).toEqual({
        type: "range",
        start: 0,
        end: 15,
      });
    });
  });

  describe("invalid / unsatisfiable -> 416", () => {
    it("start >= size (bytes=16-) -> unsatisfiable", () => {
      expect(parseRangeHeader("bytes=16-", SIZE)).toEqual({
        type: "unsatisfiable",
      });
    });
    it("start > end (bytes=5-3) -> unsatisfiable", () => {
      expect(parseRangeHeader("bytes=5-3", SIZE)).toEqual({
        type: "unsatisfiable",
      });
    });
    it("malformed (bytes=abc) -> unsatisfiable", () => {
      expect(parseRangeHeader("bytes=abc", SIZE)).toEqual({
        type: "unsatisfiable",
      });
    });
    it("malformed (bytes=0-0,1-1) multiple ranges -> unsatisfiable", () => {
      expect(parseRangeHeader("bytes=0-0,1-1", SIZE)).toEqual({
        type: "unsatisfiable",
      });
    });
    it("non-bytes unit (items=0-3) -> unsatisfiable", () => {
      expect(parseRangeHeader("items=0-3", SIZE)).toEqual({
        type: "unsatisfiable",
      });
    });
    it("bytes= (empty range) -> unsatisfiable", () => {
      expect(parseRangeHeader("bytes=", SIZE)).toEqual({
        type: "unsatisfiable",
      });
    });
    it("suffix -0 -> unsatisfiable", () => {
      expect(parseRangeHeader("bytes=-0", SIZE)).toEqual({
        type: "unsatisfiable",
      });
    });
  });

  describe("empty file (size 0)", () => {
    it("any range -> unsatisfiable", () => {
      expect(parseRangeHeader("bytes=0-", 0)).toEqual({
        type: "unsatisfiable",
      });
    });
    it("no range -> none", () => {
      expect(parseRangeHeader(undefined, 0)).toEqual({ type: "none" });
    });
  });

  describe("one-byte file (size 1)", () => {
    it("bytes=0-0 -> range {0,0}", () => {
      expect(parseRangeHeader("bytes=0-0", 1)).toEqual({
        type: "range",
        start: 0,
        end: 0,
      });
    });
    it("bytes=-5 (suffix>=size) -> whole file", () => {
      expect(parseRangeHeader("bytes=-5", 1)).toEqual({
        type: "range",
        start: 0,
        end: 0,
      });
    });
    it("bytes=1- -> unsatisfiable (out of bounds)", () => {
      expect(parseRangeHeader("bytes=1-", 1)).toEqual({
        type: "unsatisfiable",
      });
    });
  });
});
