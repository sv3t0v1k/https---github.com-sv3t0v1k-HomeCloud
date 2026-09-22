import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { UserEntity } from "./user.entity";
import { FileEntity } from "./file.entity";

@Entity("share_links")
@Index(["userId"])
@Index(["fileId"])
@Index(["token"], { unique: true })
export class ShareLinkEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 255 })
  token!: string;

  @Column({ length: 255, nullable: true })
  password!: string;

  @Column({ nullable: true, name: "expiresAt" })
  expiresAt!: Date;

  @Column({ type: "timestamptz", nullable: true, name: "lockedUntil" })
  lockedUntil!: Date | null;

  @Column({ default: true, name: "isActive" })
  isActive!: boolean;

  @Column({ type: "smallint", default: 0, name: "failedAttempts" })
  failedAttempts!: number;

  @Column({ type: "bigint", default: 0, name: "downloadCount" })
  downloadCount!: number;

  @Column({ type: "bigint", nullable: true, name: "maxDownloads" })
  maxDownloads?: number | null;

  @Column({ default: false, name: "isFolder" })
  isFolder!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user!: UserEntity;

  @Column({ name: "userId" })
  userId!: number;

  @ManyToOne(() => FileEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "fileId" })
  file!: FileEntity;

  @Column({ name: "fileId" })
  fileId!: number;
}
