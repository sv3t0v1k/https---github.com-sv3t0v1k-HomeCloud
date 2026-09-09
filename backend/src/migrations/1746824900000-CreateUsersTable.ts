import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateUsersTable1746824900000
  implements MigrationInterface
{
  name = "CreateUsersTable1746824900000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" SERIAL PRIMARY KEY,
        "email" VARCHAR(255) NOT NULL UNIQUE,
        "password" VARCHAR(255) NOT NULL,
        "name" VARCHAR(100) DEFAULT 'User',
        "isActive" BOOLEAN DEFAULT TRUE NOT NULL,
        "isEmailVerified" BOOLEAN DEFAULT FALSE NOT NULL,
        "avatar" VARCHAR(255),
        "storageQuota" BIGINT DEFAULT 0 NOT NULL,
        "storageUsed" BIGINT DEFAULT 0 NOT NULL,
        "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        "updatedAt" TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users"("email")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_email"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}