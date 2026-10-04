import { Entity, PrimaryColumn, Column, Index } from "typeorm";

@Entity("download_capabilities")
@Index(["expiresAt"])
@Index(["userId", "fileId"], { unique: true })
export class DownloadCapabilityEntity {
  @PrimaryColumn({ type: "varchar", length: 64 })
  tokenHash!: string;

  @Column({ type: "integer" })
  userId!: number;

  @Column({ type: "integer" })
  fileId!: number;

  @Column({ type: "timestamptz" })
  expiresAt!: Date;
}
