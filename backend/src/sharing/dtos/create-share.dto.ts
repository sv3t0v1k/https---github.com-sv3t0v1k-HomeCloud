export class CreateShareDto {
  fileId!: number;
  password?: string;
  expiresInDays?: number;
  isFolder?: boolean;
}
