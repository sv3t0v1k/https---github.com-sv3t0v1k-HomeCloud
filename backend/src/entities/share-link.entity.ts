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
export class ShareLinkEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 255 })
  token!: string;

  @Column({ length: 255, nullable: true })
  password!: string;

  @Column({ nullable: true, name: "expiresAt" })
  expiresAt!: Date;

  @Column({ default: true, name: "isActive" })
  isActive!: boolean;

  @Column({ type: "bigint", default: 0, name: "downloadCount" })
  downloadCount!: number;

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
