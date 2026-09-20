import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class CreateShareDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  fileId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  password?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36500)
  expiresInDays?: number;

  /** null/undefined = unlimited. Must be a positive integer when provided. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  maxDownloads?: number | null;

  @IsOptional()
  @IsBoolean()
  isFolder?: boolean;
}
