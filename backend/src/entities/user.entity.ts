import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from "typeorm";
import { FileEntity } from "./file.entity";
import { RefreshTokenEntity } from "./refresh-token.entity";

@Entity("users")
export class UserEntity {
  @PrimaryGeneratedColumn()
  id!: number;

@Column({ unique: true, length: 255, name: "email" })
  email!: string;

  @Column({ length: 255, name: "password" })
  password!: string;

  @Column({ length: 100, default: "User", name: "name" })
  name!: string;

  @Column({ default: true, name: "isActive" })
  isActive!: boolean;

  @Column({ default: false, name: "isEmailVerified" })
  isEmailVerified!: boolean;

  @Column({ length: 255, nullable: true, name: "avatar" })
  avatar!: string;

  @Column({ default: 0, name: "storageQuota" })
  storageQuota!: number;

  @Column({ default: 0, name: "storageUsed" })
  storageUsed!: number;

  @CreateDateColumn({ name: "createdAt" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updatedAt" })
  updatedAt!: Date;

  @OneToMany(() => FileEntity, (file) => file.user)
  files!: FileEntity[];

  @OneToMany(() => RefreshTokenEntity, (rt) => rt.user)
  refreshTokens!: RefreshTokenEntity[];
}
