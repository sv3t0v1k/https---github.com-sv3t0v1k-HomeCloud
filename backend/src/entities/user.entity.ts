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

  @Column({ unique: true, length: 255 })
  email!: string;

  @Column({ length: 255 })
  password!: string;

  @Column({ length: 100, default: "User" })
  name!: string;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ default: false })
  isEmailVerified!: boolean;

  @Column({ length: 255, nullable: true })
  avatar!: string;

  @Column({ default: 0 })
  storageQuota!: number;

  @Column({ default: 0 })
  storageUsed!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => FileEntity, (file) => file.user)
  files!: FileEntity[];

  @OneToMany(() => RefreshTokenEntity, (rt) => rt.user)
  refreshTokens!: RefreshTokenEntity[];
}
