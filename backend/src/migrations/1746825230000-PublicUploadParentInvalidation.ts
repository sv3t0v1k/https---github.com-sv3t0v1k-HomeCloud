import { MigrationInterface, QueryRunner } from "typeorm";

/** Preserve immutable targets while allowing the existing parent FK to invalidate them. */
export class PublicUploadParentInvalidation1746825230000 implements MigrationInterface {
  private readonly original = `NEW."parentId" IS DISTINCT FROM OLD."parentId"`;
  private readonly guarded = `(NEW."parentId" IS DISTINCT FROM OLD."parentId" AND NOT (
                  NEW."parentId" IS NULL AND OLD."parentId" IS NOT NULL AND pg_trigger_depth()>1
                  AND NOT EXISTS (SELECT 1 FROM folders WHERE id=OLD."parentId")))`;

  private async replace(runner: QueryRunner, from: string, to: string) {
    const [{ definition }] = await runner.query(
      `SELECT pg_get_functiondef('guard_public_upload_binding()'::regprocedure) AS definition`,
    );
    if (!definition.includes(from))
      throw new Error("Unexpected public upload binding guard");
    await runner.query(definition.replace(from, to));
  }
  async up(runner: QueryRunner): Promise<void> {
    await this.replace(runner, this.original, this.guarded);
  }
  async down(runner: QueryRunner): Promise<void> {
    await this.replace(runner, this.guarded, this.original);
  }
}
