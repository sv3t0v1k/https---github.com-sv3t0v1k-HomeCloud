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

  @Column({ length: 500, nullable: true })
  storagePath!: string;

  @Column({ type: "bigint", default: 0 })
  size!: number;

  @Column({ length: 100, nullable: true })
  mimeType!: string;

  @Column({ type: "text", nullable: true })
  checksum!: string;

  @Column({ default: false })
  isFolder!: boolean;

  @Column({ default: false })
  isDeleted!: boolean;

  @Column({ default: false })
  isStarred!: boolean;

  @Column({ nullable: true })
  deletedAt!: Date | null;

  @Column({ nullable: true })
  parentId!: number | null;

  @Column({ default: 0 })
  version!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => UserEntity, (user) => user.files, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user!: UserEntity;

  @Column()
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
