import { deterministicChunk } from "./full-file-http-client";

describe("full-file HTTP deterministic generator", () => {
  it("is stable and index-specific at exact chunk boundaries", () => {
    expect(deterministicChunk(4, 0)).toEqual(Buffer.alloc(4, 19));
    expect(deterministicChunk(4, 1)).toEqual(Buffer.alloc(4, 92));
    expect(deterministicChunk(50 * 1024 * 1024, 0).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(deterministicChunk(50 * 1024 * 1024, 9)).toHaveLength(
      50 * 1024 * 1024,
    );
  });
  it("rejects invalid boundaries", () => {
    expect(() => deterministicChunk(0, 0)).toThrow();
    expect(() => deterministicChunk(1, -1)).toThrow();
  });
});
