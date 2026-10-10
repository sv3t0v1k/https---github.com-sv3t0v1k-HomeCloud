import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

export const LEGACY_UPLOAD_WORKSPACE_ID =
  "87798389-88af-4ea5-a3e7-8e69a3c7bb01";
export const LEGACY_UPLOAD_WORKSPACE_KEY = "legacy-upload-workspace";
export const LEGACY_UPLOAD_WORKSPACE_MOUNT_KEY = "legacy-storage";

/** Identity only: roots come exclusively from operator-approved runtime bindings. */
@Entity("upload_workspaces")
export class UploadWorkspaceEntity {
  @PrimaryColumn({ type: "uuid" })
  id!: string;
  @Column({ type: "varchar", length: 100, unique: true })
  machineKey!: string;
  @Column({ type: "varchar", length: 100, unique: true })
  mountKey!: string;
  @Column({ type: "varchar", length: 32, default: "local_filesystem" })
  type!: string;
  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}

export const LEGACY_UPLOAD_WORKSPACE = {
  id: LEGACY_UPLOAD_WORKSPACE_ID,
  machineKey: LEGACY_UPLOAD_WORKSPACE_KEY,
  mountKey: LEGACY_UPLOAD_WORKSPACE_MOUNT_KEY,
  type: "local_filesystem",
};
