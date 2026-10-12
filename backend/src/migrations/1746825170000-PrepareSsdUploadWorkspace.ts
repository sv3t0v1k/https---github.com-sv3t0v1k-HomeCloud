import { MigrationInterface, QueryRunner } from "typeorm";
import { SSD_UPLOAD_WORKSPACE } from "../entities/upload-workspace.entity";

/** Identity only. Existing session/File guards stay sealed to legacy placement.
 * No filesystem operations or remapping of existing data.
 */
export class PrepareSsdUploadWorkspace1746825170000 implements MigrationInterface {
  public async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error("SSD workspace preparation requires a transaction");
    await runner.query(
      `LOCK TABLE "upload_workspaces" IN ACCESS EXCLUSIVE MODE`,
    );
    await runner.query(
      `INSERT INTO "upload_workspaces" (id, "machineKey", "mountKey", type) VALUES ($1,$2,$3,$4)`,
      [
        SSD_UPLOAD_WORKSPACE.id,
        SSD_UPLOAD_WORKSPACE.machineKey,
        SSD_UPLOAD_WORKSPACE.mountKey,
        SSD_UPLOAD_WORKSPACE.type,
      ],
    );
  }

  public async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error("SSD workspace preparation requires a transaction");
    // FK RESTRICT prevents deleting an identity used by any future session.
    const rows = await runner.query(
      `WITH removed AS (DELETE FROM "upload_workspaces" WHERE id=$1 AND "machineKey"=$2 AND "mountKey"=$3 AND type=$4 RETURNING id) SELECT id FROM removed`,
      [
        SSD_UPLOAD_WORKSPACE.id,
        SSD_UPLOAD_WORKSPACE.machineKey,
        SSD_UPLOAD_WORKSPACE.mountKey,
        SSD_UPLOAD_WORKSPACE.type,
      ],
    );
    if (rows.length !== 1)
      throw new Error("SSD workspace identity missing or inconsistent");
  }
}
