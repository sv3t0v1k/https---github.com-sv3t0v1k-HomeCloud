import { IsNumber, Min } from 'class-validator';

export class ChunkDto {
  @IsNumber()
  @Min(0)
  chunkIndex: number;
}
