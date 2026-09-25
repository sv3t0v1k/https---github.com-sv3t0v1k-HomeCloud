import {
  DEFAULT_MAX_CHUNK_SIZE,
  getMulterFileSizeLimit,
} from "./chunk-ingress";

describe("multipart ingress limits", () => {
  it("keeps MAX_CHUNK_SIZE inclusive at the transport boundary", () => {
    expect(getMulterFileSizeLimit(String(50 * 1024 * 1024))).toBe(
      50 * 1024 * 1024 + 1,
    );
  });

  it("applies the same inclusive boundary to the default", () => {
    expect(getMulterFileSizeLimit(undefined)).toBe(DEFAULT_MAX_CHUNK_SIZE + 1);
  });

  it("rejects a transport limit that cannot be represented safely", () => {
    expect(() => getMulterFileSizeLimit(Number.MAX_SAFE_INTEGER)).toThrow(
      "MAX_CHUNK_SIZE is too large",
    );
  });
});
