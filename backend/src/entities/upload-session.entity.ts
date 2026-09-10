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

  @Column({ length: 255, name: "uploadId" })
  uploadId!: string;

  @Column({ length: 255 })
  filename!: string;

  @Column({ type: "bigint", name: "totalSize" })
  totalSize!: number;

  @Column({ type: "bigint", default: 0, name: "uploadedSize" })
  uploadedSize!: number;

  @Column({ type: "int", default: 0, name: "chunkSize" })
  chunkSize!: number;

  @Column({ type: "int", default: 0, name: "totalChunks" })
  totalChunks!: number;

  @Column({ type: "json", default: "[]", name: "uploadedChunks" })
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
