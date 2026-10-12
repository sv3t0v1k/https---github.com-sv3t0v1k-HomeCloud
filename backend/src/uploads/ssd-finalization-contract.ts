import { FileEntity } from "../entities/file.entity";

export interface FinalizationBinding {
  sourceWorkspaceId: string;
  sourceRoot: string;
  sourcePath: string;
  sourceDevice: string;
  sourceInode: string;
  sourceDirectoryDevice: string;
  sourceDirectoryInode: string;
  targetStorageId: string;
  targetRoot: string;
  targetDevice: string;
  targetInode: string;
  targetDirectoryDevice: string;
  targetDirectoryInode: string;
  temporaryPath: string;
  storagePath: string;
  relativeObjectKey: string;
}
export interface FinalizationOperation {
  id: string;
  sessionId: number;
  userId: number;
  uploadId: string;
  filename: string;
  parentId: number | null;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  expectedSha256: string;
  binding: FinalizationBinding;
}
export interface FinalizationChunk {
  chunkIndex: number;
  byteSize: number;
  sha256: string;
}
export interface FinalizationStore {
  begin(input: {
    id: string;
    userId: number;
    uploadId: string;
    expectedSha256: string;
    binding: FinalizationBinding;
  }): Promise<FinalizationOperation>;
  chunks(operationId: string): AsyncIterable<FinalizationChunk>;
  transition(
    operationId: string,
    from: "assembling" | "verified" | "publishing",
    to: "verified" | "publishing" | "published",
  ): Promise<void>;
  commit(operationId: string): Promise<FileEntity>;
}
export interface FinalizationFilesystem {
  prepare(
    userId: number,
    uploadId: string,
    operationId: string,
  ): FinalizationBinding;
  assertBinding(binding: FinalizationBinding): void;
  openChunk(binding: FinalizationBinding, index: number): number;
  createTemporary(binding: FinalizationBinding): number;
  publish(binding: FinalizationBinding): void;
  close(): void;
}
