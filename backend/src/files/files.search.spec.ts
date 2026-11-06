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
  const findAll = jest.fn().mockResolvedValue([]);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [
        { provide: FilesService, useValue: { search, findAll } },
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

  beforeEach(() => { search.mockClear(); findAll.mockClear(); });

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
  it("сохраняет массив и параметры старого поиска, включая один символ", async () => {
    const response = await request(app.getHttpServer()).get("/api/v1/files")
      .query({ search: " a ", parentId: "7", limit: "10", offset: "20" }).expect(200);
    expect(response.body).toEqual([]);
    expect(findAll).toHaveBeenCalledWith(42, 7, "a", false, 10, 20);
  });

  it("сохраняет обычное чтение каталога без search", async () => {
    await request(app.getHttpServer()).get("/api/v1/files").query({ parentId: "7" }).expect(200);
    expect(findAll).toHaveBeenCalledWith(42, 7, undefined);
  });

  it.each([
    "search=", "search=%20%20", "search=ab%00cd", "search=" + "x".repeat(101),
    "search=a&search=b", "search[x]=a", "search=a&parentId=1x",
    "search=a&parentId=0", "search=a&limit=0", "search=a&offset=10001",
    "q=ab&q=cd", "q[x]=ab", "q=ab&limit=1&limit=2",
  ])("отклоняет неоднозначные/невалидные параметры %s", async (query) => {
    await request(app.getHttpServer()).get(`/api/v1/files${query.startsWith("q") ? "/search" : ""}?${query}`).expect(400);
    expect(search).not.toHaveBeenCalled();
    expect(findAll).not.toHaveBeenCalled();
  });

});

describe("GS-1A: search response contract", () => {
  it("escapes LIKE characters and exposes only public fields", async () => {
    const query = jest.fn().mockResolvedValue([{
      kind: "file", id: 9, name: "100%_!.txt", parentId: null,
      size: "12", mimeType: "text/plain", isStarred: false, shareFileId: null,
      createdAt: new Date(), updatedAt: new Date(),
      storagePath: "/private/path", relativeObjectKey: "private-key",
      storageLocationId: "private-location", userId: 42,
    }]);
    const manager = {
      transaction: async (
        action: (scope: { query: typeof query }) => Promise<unknown>,
      ) => action({ query }),
    };
    const service = new FilesService(
      { manager } as never, {} as never, {} as never, {} as never,
    );

    const result = await service.search(42, "100%_!", 7, 14);

    expect(query).toHaveBeenNthCalledWith(
      1, "SET LOCAL statement_timeout = '2000ms'",
    );
    expect(query).toHaveBeenNthCalledWith(
      2, expect.stringContaining("LIMIT $3 OFFSET $4"),
      [42, "%100!%!_!!%", 8, 14, false, null],
    );
    expect(result).toEqual({
      files: [{ id: 9, name: "100%_!.txt", parentId: null,
        size: "12", mimeType: "text/plain", isStarred: false,
        createdAt: expect.any(Date), updatedAt: expect.any(Date) }],
      folders: [], limit: 7, offset: 14, hasMore: false,
    });
  });
});

describe("GS-1A: ограничение времени SQL", () => {
  it("возвращает безопасную ошибку 503 при таймауте PostgreSQL", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce({ driverError: { code: "57014" } });
    const manager = {
      transaction: async (
        action: (scope: { query: typeof query }) => Promise<unknown>,
      ) => action({ query }),
    };
    const service = new FilesService(
      { manager } as never, {} as never, {} as never, {} as never,
    );
    await expect(service.search(42, "report")).rejects.toThrow(
      "Search temporarily unavailable",
    );
    expect(query).toHaveBeenCalledTimes(2);
  });
});
