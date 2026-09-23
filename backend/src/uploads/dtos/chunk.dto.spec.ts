import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { ChunkDto } from "./chunk.dto";

describe("ChunkDto", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  async function transform(chunkIndex: unknown): Promise<ChunkDto> {
    return pipe.transform(
      { chunkIndex },
      { type: "body", metatype: ChunkDto },
    ) as Promise<ChunkDto>;
  }

  it.each(["0", "1", "42"])(
    "преобразует multipart-строку %s в целое число",
    async (chunkIndex) => {
      const dto = await transform(chunkIndex);

      expect(dto.chunkIndex).toBe(Number(chunkIndex));
      expect(typeof dto.chunkIndex).toBe("number");
    },
  );

  it("сохраняет допустимое числовое значение JSON", async () => {
    await expect(transform(1)).resolves.toMatchObject({ chunkIndex: 1 });
  });

  it.each(["abc", "1.5", "", " 1", 1.5, -1, "-1"])(
    "отклоняет недопустимый индекс %p",
    async (chunkIndex) => {
      await expect(transform(chunkIndex)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );
});
