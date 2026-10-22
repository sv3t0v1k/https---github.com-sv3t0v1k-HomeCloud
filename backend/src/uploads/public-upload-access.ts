import { EntityManager } from "typeorm";
import { UploadSessionEntity } from "../entities/upload-session.entity";

/** Internal capability constructed by Sharing; never populated from an upload DTO. */
export interface PublicUploadAccess {
  readonly userId: number;
  readonly shareLinkId: number;
  readonly shareRootFolderId: number;
  authorize(
    manager: EntityManager,
    parentId: number,
    lock: boolean,
  ): Promise<void>;
  replay?(manager: EntityManager): Promise<UploadSessionEntity | null>;
  receipt?(manager: EntityManager, session: UploadSessionEntity): Promise<void>;
}

export const PUBLIC_UPLOAD = Symbol("public-upload-admission");
export interface PublicUploadAdmission {
  userId: number;
  session: UploadSessionEntity;
}
