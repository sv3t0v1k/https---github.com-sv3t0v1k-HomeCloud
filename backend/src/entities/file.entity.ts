import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from "typeorm";
import { UserEntity } from "./user.entity";
import { FolderEntity } from "./folder.entity";
import { ShareLinkEntity } from "./share-link.entity";

@Entity("files")
@Index(["parentId"])
@Index(["isDeleted"])
@Index(["mimeType"])
export class FileEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 255 })
  name!: string;

  @Column({ length: 500, nullable: true, name: "storagePath" })
  storagePath!: string;

  @Column({ type: "bigint", default: 0, name: "size" })
  size!: number;

  @Column({ length: 100, nullable: true, name: "mimeType" })
  mimeType!: string;

  @Column({ type: "text", nullable: true, name: "checksum" })
  checksum!: string;

  @Column({ default: false, name: "isFolder" })
  isFolder!: boolean;

  @Column({ default: false, name: "isDeleted" })
  isDeleted!: boolean;

  @Column({ default: false, name: "isStarred" })
  isStarred!: boolean;

  @Column({ type: "timestamp", nullable: true, name: "deletedAt" })
  deletedAt!: Date | null;

  @Column({ nullable: true, name: "parentId" })
  parentId!: number | null;

  @Column({ default: 0, name: "version" })
  version!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => UserEntity, (user) => user.files, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user!: UserEntity;

  @Column({ name: "userId" })
  userId!: number;

  @ManyToOne(() => FolderEntity, (folder) => folder.files, {
    nullable: true,
    onDelete: "SET NULL",
  })
  @JoinColumn({ name: "parentId" })
  parent!: FolderEntity;

  @OneToMany(() => ShareLinkEntity, (share) => share.file)
  shares!: ShareLinkEntity[];
}
