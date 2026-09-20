import { IsString, IsNumber, IsOptional, MaxLength, Min } from "class-validator";

export class CreateSessionDto {
  @IsString()
  @MaxLength(255)
  filename!: string;

  @IsNumber()
  @Min(1)
  totalSize!: number;

  @IsNumber()
  @Min(1)
  chunkSize!: number;

  @IsOptional()
  @IsNumber()
  parentId?: number;
}
