import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/** Durable idempotency receipt; never grants access without a live share check. */
@Entity("public_share_operations")
@Index(
  "uq_public_share_operation_retry",
  ["shareLinkId", "kind", "idempotencyKey"],
  {
    unique: true,
    where: '"shareLinkId" IS NOT NULL',
  },
)
@Index("idx_public_share_operation_expiry", ["expiresAt"])
@Check(
  "CHK_public_share_operation_result",
  `("kind" = 'mkdir' AND "resultUploadSessionId" IS NULL) OR ("kind" = 'upload_session' AND "resultFolderId" IS NULL)`,
)
@Check("CHK_public_share_operation_expiry", `"expiresAt" > "createdAt"`)
export class PublicShareOperationEntity {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ type: "int", nullable: true })
  shareLinkId!: number | null;

  @Column({ type: "int", nullable: true })
  shareRootFolderId!: number | null;

  @Column({ type: "int" })
  userId!: number;

  @Column({ type: "varchar", length: 16 })
  kind!: "mkdir" | "upload_session";

  @Column({ type: "uuid" })
  idempotencyKey!: string;

  @Column({ type: "varchar", length: 64 })
  requestSha256!: string;

  @Column({ type: "int", nullable: true })
  resultFolderId!: number | null;

  @Column({ type: "int", nullable: true })
  resultUploadSessionId!: number | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @Column({ type: "timestamptz" })
  expiresAt!: Date;
}
