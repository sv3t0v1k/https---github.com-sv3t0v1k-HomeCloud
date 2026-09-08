import { IsString, IsNumber, IsOptional, Min } from 'class-validator';

export class CreateSessionDto {
  @IsString()
  filename: string;

  @IsNumber()
  @Min(1)
  totalSize: number;

  @IsNumber()
  @Min(1)
  chunkSize: number;

  @IsOptional()
  @IsNumber()
  parentId?: number;
}
