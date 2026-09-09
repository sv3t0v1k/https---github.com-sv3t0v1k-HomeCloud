import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateRefreshTokensTable1746825000000
  implements MigrationInterface
{
  name = "CreateRefreshTokensTable1746825000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        token_hash VARCHAR(255) NOT NULL,
        replaced_by TEXT,
        revoked BOOLEAN DEFAULT FALSE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_refresh_tokens_user_id`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_refresh_tokens_token_hash`);
    await queryRunner.query(`DROP TABLE IF EXISTS refresh_tokens`);
  }
}
