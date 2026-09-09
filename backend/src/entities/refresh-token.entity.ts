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

  @Column({ length: 255 })
  tokenHash!: string;

  @Column({ type: "text", nullable: true })
  replacedBy?: string;

  @Column({ default: false })
  revoked!: boolean;

  @Column({ type: "timestamp" })
  expiresAt!: Date;

  @Column({ type: "timestamp", nullable: true })
  revokedAt?: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @ManyToOne(() => UserEntity, (user) => user.refreshTokens, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "userId" })
  user!: UserEntity;

  @Column()
  userId!: number;
}
