import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import {
  LEGACY_STORAGE_ID,
  LEGACY_STORAGE_KEY,
} from "../storage/storage-placement";

@Entity("storage_locations")
export class StorageLocationEntity {
  @PrimaryColumn({ type: "uuid" })
  id!: string;
  @Column({ type: "varchar", length: 100, unique: true })
  machineKey!: string;
  @Column({ type: "varchar", length: 255 })
  displayName!: string;
  // Approved deployment reference. Absolute roots are never DB placement authority.
  @Column({ type: "varchar", length: 100, unique: true })
  mountKey!: string;
  @Column({ type: "varchar", length: 32, default: "local_filesystem" })
  type!: string;
  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}

export const LEGACY_STORAGE_LOCATION = {
  id: LEGACY_STORAGE_ID,
  machineKey: LEGACY_STORAGE_KEY,
  mountKey: LEGACY_STORAGE_KEY,
  displayName: "Основное хранилище",
  type: "local_filesystem",
};
