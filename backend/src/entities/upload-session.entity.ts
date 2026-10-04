import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { UserEntity } from "./user.entity";

const safeBigintNumberTransformer = {
  to: (value: number): number => value,
  from: (value: string | number): number => {
    const numberValue = Number(value);
    if (!Number.isSafeInteger(numberValue)) {
      throw new RangeError(
        `BIGINT value is outside the safe integer range: ${value}`,
      );
    }
    return numberValue;
  },
};

@Entity("upload_sessions")
export class UploadSessionEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 255, name: "uploadId" })
  uploadId!: string;

  @Column({ length: 255 })
  filename!: string;

  @Column({
    type: "bigint",
    name: "totalSize",
    transformer: safeBigintNumberTransformer,
  })
  totalSize!: number;

  @Column({
    type: "bigint",
    default: 0,
    name: "uploadedSize",
    transformer: safeBigintNumberTransformer,
  })
  uploadedSize!: number;

  @Column({ type: "int", default: 0, name: "chunkSize" })
  chunkSize!: number;

  @Column({ type: "int", default: 0, name: "totalChunks" })
  totalChunks!: number;

  @Column({ type: "int", default: 0, name: "uploadedCount" })
  uploadedCount!: number;

  @Column({ type: "boolean", default: false, name: "accountingInitialized" })
  accountingInitialized!: boolean;

  // Preserved legacy data; never read or rewrite a growing array.
  @Column({
    type: "jsonb",
    default: "[]",
    name: "uploadedChunks",
    select: false,
  })
  uploadedChunks!: number[];

  @Column({ length: 500, name: "tempPath" })
  tempPath!: string;

  @Column({ type: "int", nullable: true, name: "parentId" })
  parentId!: number | null;

  @Column({ default: "pending" })
  status!: string;

  @Column({ type: "timestamp", nullable: true, name: "expiresAt" })
  expiresAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user!: UserEntity;

  @Column({ name: "userId" })
  userId!: number;
}
