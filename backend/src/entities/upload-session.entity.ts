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

@Entity("upload_sessions")
export class UploadSessionEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 255, name: "upload_id" })
  uploadId!: string;

  @Column({ length: 255, name: "filename" })
  filename!: string;

  @Column({ type: "bigint", name: "total_size" })
  totalSize!: number;

  @Column({ type: "bigint", default: 0, name: "uploaded_size" })
  uploadedSize!: number;

  @Column({ type: "int", default: 0, name: "chunk_size" })
  chunkSize!: number;

  @Column({ type: "int", default: 0, name: "total_chunks" })
  totalChunks!: number;

  @Column({ type: "json", default: "[]", name: "uploaded_chunks" })
  uploadedChunks!: number[];

  @Column({ length: 500, name: "temp_path" })
  tempPath!: string;

  @Column({ type: "int", nullable: true, name: "parent_id" })
  parentId!: number | null;

  @Column({ default: "pending", name: "status" })
  status!: string;

  @Column({ type: "timestamp", nullable: true, name: "expires_at" })
  expiresAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: UserEntity;

  @Column({ name: "user_id" })
  userId!: number;
}
