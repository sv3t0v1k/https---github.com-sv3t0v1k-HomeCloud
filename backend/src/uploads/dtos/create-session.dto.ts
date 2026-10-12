import {
  IsString,
  IsNumber,
  IsOptional,
  MaxLength,
  Min,
  Matches,
  Length,
  ValidateIf,
} from "class-validator";

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

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(64, 64)
  @Matches(/^[0-9a-f]{64}$/)
  expectedSha256?: string;

  @IsOptional()
  @IsNumber()
  parentId?: number;
}
