import { ConfigService } from "@nestjs/config";
import { DataSource, UpdateQueryBuilder, UpdateResult } from "typeorm";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UserEntity } from "../entities/user.entity";
import { SharingService } from "./sharing.service";

class MetadataOnlyDataSource extends DataSource {
  async prepareMetadata(): Promise<void> {
    await this.buildMetadatas();
  }
}

describe("SharingService — SQL ограничения скачиваний", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("сохраняет token, active и expiry обязательными для обеих ветвей лимита", async () => {
    // Настоящий PostgreSQL query builder; соединение с БД не открывается.
    const dataSource = new MetadataOnlyDataSource({
      type: "postgres",
      entities: [
        ShareLinkEntity,
        FileEntity,
        UserEntity,
        FolderEntity,
        RefreshTokenEntity,
      ],
    });
    await dataSource.prepareMetadata();

    let generatedSql = "";
    let parameters: unknown[] = [];
    jest
      .spyOn(UpdateQueryBuilder.prototype, "execute")
      .mockImplementation(async function (
        this: UpdateQueryBuilder<ShareLinkEntity>,
      ): Promise<UpdateResult> {
        [generatedSql, parameters] = this.getQueryAndParameters();
        return { raw: [{ downloadCount: 1 }], affected: 1, generatedMaps: [] };
      });

    const service = new SharingService(
      dataSource.getRepository(ShareLinkEntity),
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(UserEntity),
      new ConfigService(),
    );
    const token = "token-with-'quote";

    await expect(service.incrementDownloadCount(token)).resolves.toEqual({
      downloadCount: 1,
    });

    expect(generatedSql).toContain('UPDATE "share_links"');
    expect(generatedSql).toContain('"downloadCount" = "downloadCount" + 1');
    expect(generatedSql).toContain(
      'WHERE "token" = $1 AND "isActive" = true AND ("expiresAt" IS NULL OR "expiresAt" > NOW()) AND ("maxDownloads" IS NULL OR "downloadCount" < "maxDownloads")',
    );
    expect(generatedSql).toContain('RETURNING "downloadCount"');
    expect(parameters).toEqual([token]);
    expect(generatedSql).not.toContain(token);
  });
});
