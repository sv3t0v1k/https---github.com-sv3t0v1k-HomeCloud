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
import { FileEntity } from "./file.entity";

@Entity("share_links")
export class ShareLinkEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 255 })
  token!: string;

  @Column({ length: 255, nullable: true })
  password!: string;

  @Column({ nullable: true, name: "expires_at" })
  expiresAt!: Date;

  @Column({ default: true, name: "is_active" })
  isActive!: boolean;

  @Column({ type: "bigint", default: 0, name: "download_count" })
  downloadCount!: number;

  @Column({ default: false, name: "is_folder" })
  isFolder!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: UserEntity;

  @Column({ name: "user_id" })
  userId!: number;

  @ManyToOne(() => FileEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "file_id" })
  file!: FileEntity;

  @Column({ name: "file_id" })
  fileId!: number;
}
