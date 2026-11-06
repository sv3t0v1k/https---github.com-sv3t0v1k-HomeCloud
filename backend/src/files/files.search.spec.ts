import { ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { StorageService } from "../storage/storage.service";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";

describe("GS-1A: HTTP search contract", () => {
  let app: INestApplication;
  const search = jest.fn().mockResolvedValue({ files: [], folders: [] });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [
        { provide: FilesService, useValue: { search } },
        { provide: StorageService, useValue: {} },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context.switchToHttp().getRequest().user = { userId: 42 };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => search.mockClear());

  it("trims the query and applies bounded defaults", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/files/search")
      .query({ q: "  Привет  " })
      .expect(200);

    expect(search).toHaveBeenCalledWith(42, "Привет", 20, 0);
  });

  it("accepts explicit valid pagination", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/files/search")
      .query({ q: "report", limit: "50", offset: "100" })
      .expect(200);

    expect(search).toHaveBeenCalledWith(42, "report", 50, 100);
  });

  it.each(["", "x", "x".repeat(101), "ab\ncd"])(
    "rejects invalid query %j",
    async (q) => {
      await request(app.getHttpServer())
        .get("/api/v1/files/search")
        .query({ q })
        .expect(400);

      expect(search).not.toHaveBeenCalled();
    },
  );

  it.each([
    { limit: "0" },
    { limit: "51" },
    { limit: "-1" },
    { limit: "1.5" },
    { limit: "01" },
    { offset: "-1" },
    { offset: "10001" },
    { offset: "abc" },
  ])("rejects invalid pagination %j", async (params) => {
    await request(app.getHttpServer())
      .get("/api/v1/files/search")
      .query({ q: "report", ...params })
      .expect(400);

    expect(search).not.toHaveBeenCalled();
  });
});

describe("GS-1A: query builder contract", () => {
  function builder() {
    return {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
  }

  it("escapes LIKE wildcards, scopes by owner and bounds both queries", async () => {
    const fileQuery = builder();
    const folderQuery = builder();

    const service = new FilesService(
      { createQueryBuilder: jest.fn(() => fileQuery) } as never,
      { createQueryBuilder: jest.fn(() => folderQuery) } as never,
      {} as never,
      {} as never,
    );

    await service.search(42, "100%_!", 7, 14);

    expect(fileQuery.where).toHaveBeenCalledWith(
      "file.userId = :userId", { userId: 42 },
    );
    expect(folderQuery.where).toHaveBeenCalledWith(
      "folder.userId = :userId", { userId: 42 },
    );

    expect(fileQuery.andWhere).toHaveBeenCalledWith(
      "file.isDeleted = :isDeleted", { isDeleted: false },
    );
    expect(folderQuery.andWhere).toHaveBeenCalledWith(
      "folder.isDeleted = :isDeleted", { isDeleted: false },
    );

    expect(fileQuery.andWhere).toHaveBeenCalledWith(
      "file.name ILIKE :query ESCAPE '!'",
      { query: "%100!%!_!!%" },
    );
    expect(folderQuery.andWhere).toHaveBeenCalledWith(
      "folder.name ILIKE :query ESCAPE '!'",
      { query: "%100!%!_!!%" },
    );

    for (const query of [fileQuery, folderQuery]) {
      expect(query.take).toHaveBeenCalledWith(7);
      expect(query.skip).toHaveBeenCalledWith(14);
      expect(query.getMany).toHaveBeenCalledTimes(1);
    }

    expect(fileQuery.addOrderBy).toHaveBeenCalledWith("file.id", "ASC");
    expect(folderQuery.addOrderBy).toHaveBeenCalledWith("folder.id", "ASC");
  });
});
