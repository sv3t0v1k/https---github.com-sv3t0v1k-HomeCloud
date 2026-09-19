import { IsInt, IsOptional, Min } from "class-validator";

export class CreateShareDto {
  fileId!: number;

  password?: string;

  expiresInDays?: number;

  /** null/undefined = unlimited. Must be a positive integer when provided. */
  @IsOptional()
  @IsInt()
  @Min(1)
  maxDownloads?: number | null;

  isFolder?: boolean;
}
