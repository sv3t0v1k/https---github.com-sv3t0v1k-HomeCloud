import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { UploadSessionEntity } from "./upload-session.entity";

@Entity("upload_chunks")
export class UploadChunkEntity {
  @PrimaryColumn({ type: "int", name: "sessionId" })
  sessionId!: number;
  @PrimaryColumn({ type: "int", name: "chunkIndex" })
  chunkIndex!: number;
  @Column({ type: "int" })
  byteSize!: number;
  @Column({ type: "varchar", length: 64 })
  sha256!: string;
  @ManyToOne(() => UploadSessionEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "sessionId" })
  session!: UploadSessionEntity;
}
