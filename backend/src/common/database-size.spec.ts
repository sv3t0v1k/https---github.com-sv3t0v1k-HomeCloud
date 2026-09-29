import { BadRequestException } from "@nestjs/common";
import { parseDatabaseSize } from "./database-size";

describe("parseDatabaseSize", () => {
  it.each([0, 125, "125", "1000", String(Number.MAX_SAFE_INTEGER)])(
    "normalizes %p without loss", (value) => {
      expect(parseDatabaseSize(value)).toBe(Number(value));
    },
  );
  it.each([
    null, undefined, -1, "-1", NaN, Infinity, 1.5, "1.5",
    Number.MAX_SAFE_INTEGER + 1, "9007199254740993", true, {}, [], "", " ", "1e3",
  ])("rejects invalid database value %p", (value) => {
    expect(() => parseDatabaseSize(value)).toThrow(BadRequestException);
  });
});
