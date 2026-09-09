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
import { FileEntity } from "./file.entity";

@Entity("folders")
@Index(["parentId"])
export class FolderEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 255 })
  name!: string;

  @Column({ default: false, name: "is_deleted" })
  isDeleted!: boolean;

  @Column({ type: "timestamp", nullable: true, name: "deleted_at" })
  deletedAt!: Date | null;

  @Column({ nullable: true, name: "parent_id" })
  parentId!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => UserEntity, (user) => user.files, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: UserEntity;

  @Column({ name: "user_id" })
  userId!: number;

  @ManyToOne(() => FolderEntity, (folder) => folder.children, {
    nullable: true,
    onDelete: "SET NULL",
  })
  @JoinColumn({ name: "parent_id" })
  parent!: FolderEntity;

  @OneToMany(() => FolderEntity, (folder) => folder.children)
  children!: FolderEntity[];

  @OneToMany(() => FileEntity, (file) => file.parent)
  files!: FileEntity[];
}
