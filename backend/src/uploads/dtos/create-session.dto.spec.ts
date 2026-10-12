import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { CreateSessionDto } from "./create-session.dto";

describe("CreateSessionDto whole checksum contract", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const transform = (fields: Record<string, unknown> = {}) =>
    pipe.transform(
      { filename: "file.bin", totalSize: 8, chunkSize: 4, ...fields },
      { type: "body", metatype: CreateSessionDto },
    );

  it("permits a legacy request without a whole-file checksum", async () => {
    expect((await transform()).expectedSha256).toBeUndefined();
  });

  it("preserves a lowercase SHA256 without coercion", async () => {
    const expectedSha256 = "0123456789abcdef".repeat(4);
    await expect(transform({ expectedSha256 })).resolves.toMatchObject({
      expectedSha256,
    });
  });

  it.each([
    null,
    123,
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    " " + "a".repeat(64),
    "a".repeat(64) + "\n",
  ])("rejects a malformed whole checksum %p", async (expectedSha256) => {
    await expect(transform({ expectedSha256 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
