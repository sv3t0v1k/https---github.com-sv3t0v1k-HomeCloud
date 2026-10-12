import { FileEntity } from "../entities/file.entity";
import {
  FinalizationBinding,
  FinalizationChunk,
  FinalizationOperation,
  FinalizationStore,
} from "./ssd-finalization-contract";

export interface ArtifactIdentity {
  device: string;
  inode: string;
}
export type RecoveryState =
  "assembling" | "verified" | "publishing" | "published" | "committed";
export interface RecoveryOperation extends FinalizationOperation {
  state: RecoveryState;
  targetIdentity: ArtifactIdentity | null;
  cleanupState: "pending" | "cleaned";
}
export interface RecoveryStore extends FinalizationStore {
  lookup(
    id: string,
  ): Promise<{ operation: RecoveryOperation; file: FileEntity | null }>;
  recordTarget(id: string, identity: ArtifactIdentity): Promise<void>;
  finishCleanup(id: string): Promise<void>;
  pending(): AsyncIterable<string>;
}
export interface RecoveryFilesystem {
  // Also holds a kernel nonblocking exclusive lock until close. Never steal a live lock.
  reopen(operation: RecoveryOperation): void;
  assertBinding(binding: FinalizationBinding): void;
  inspectTarget(
    binding: FinalizationBinding,
    final: boolean,
  ): { fd: number; identity: ArtifactIdentity } | null;
  createTemporary(binding: FinalizationBinding): number;
  // Only reset an inode already recorded by the journal; unknown objects survive.
  resetTemporary(
    binding: FinalizationBinding,
    identity: ArtifactIdentity,
  ): number;
  openChunk(binding: FinalizationBinding, index: number): number;
  publish(binding: FinalizationBinding): void;
  syncTarget(binding: FinalizationBinding, final: boolean): void;
  // ENOENT is repeatable success, everything else must match an owned verified descriptor.
  removeChunk(
    binding: FinalizationBinding,
    part: FinalizationChunk,
    identity: ArtifactIdentity,
  ): void;
  syncSource(binding: FinalizationBinding): void;
  close(): void;
}
