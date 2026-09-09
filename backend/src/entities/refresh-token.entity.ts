import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { UserEntity } from "./user.entity";

@Entity("refresh_tokens")
@Index(["tokenHash"], { unique: true })
@Index(["userId", "revoked"])
export class RefreshTokenEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 255, name: "token_hash" })
  tokenHash!: string;

  @Column({ type: "text", nullable: true, name: "replaced_by" })
  replacedBy?: string;

  @Column({ default: false })
  revoked!: boolean;

  @Column({ type: "timestamp", name: "expires_at" })
  expiresAt!: Date;

  @Column({ type: "timestamp", nullable: true, name: "revoked_at" })
  revokedAt?: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @ManyToOne(() => UserEntity, (user) => user.refreshTokens, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "user_id" })
  user!: UserEntity;

  @Column({ name: "user_id" })
  userId!: number;
}
