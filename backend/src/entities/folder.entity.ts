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

  @Column({ default: false })
  isDeleted!: boolean;

  @Column({ nullable: true })
  deletedAt!: Date | null;

  @Column({ nullable: true })
  parentId!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => UserEntity, (user) => user.files, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user!: UserEntity;

  @Column()
  userId!: number;

  @ManyToOne(() => FolderEntity, (folder) => folder.children, {
    nullable: true,
    onDelete: "SET NULL",
  })
  @JoinColumn({ name: "parentId" })
  parent!: FolderEntity;

  @OneToMany(() => FolderEntity, (folder) => folder.children)
  children!: FolderEntity[];

  @OneToMany(() => FileEntity, (file) => file.parent)
  files!: FileEntity[];
}
