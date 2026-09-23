import { Transform } from "class-transformer";
import { IsInt, Min } from "class-validator";

export class ChunkDto {
  @Transform(({ value }) =>
    typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(0)
  chunkIndex!: number;
}
