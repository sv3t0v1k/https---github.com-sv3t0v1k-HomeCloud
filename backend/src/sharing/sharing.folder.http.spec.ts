import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { StorageService } from "../storage/storage.service";
import { SharingController } from "./sharing.controller";
import { SharingService } from "./sharing.service";

describe("SharingController — folder sharing HTTP boundary", () => {
  let app: INestApplication;
  const sharing = {
    listSharedChildren: jest.fn(),
    findShareByToken: jest.fn(),
    verifySharePassword: jest.fn(),
    resolveSharedFolderFile: jest.fn(),
    incrementFolderDownloadCount: jest.fn(),
    incrementDownloadCount: jest.fn(),
    listArchiveMembers: jest.fn(),
    streamFolderArchive: jest.fn(),
    incrementFolderArchiveDownloadCount: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SharingController],
      providers: [
        { provide: SharingService, useValue: sharing },
        {
          provide: StorageService,
          useValue: { ensureWithinStorageRoot: (p: string) => p },
        },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("forwards validated pagination and password header without putting it in URL", async () => {
    sharing.listSharedChildren.mockResolvedValue({ items: [], hasMore: false });
    await request(app.getHttpServer())
      .get("/api/v1/sharing/public/token/children?parentId=40&limit=25&offset=5")
      .set("X-Share-Password", "secret")
      .expect(200);
    expect(sharing.listSharedChildren).toHaveBeenCalledWith(
      "token",
      { parentId: 40, limit: 25, offset: 5 },
      "secret",
    );
  });

  it.each([
    "parentId=0",
    "parentId=1.5",
    "limit=0",
    "limit=101",
    "offset=-1",
    "limit=10&unknown=value",
  ])("rejects invalid query: %s", async (query) => {
    await request(app.getHttpServer())
      .get(`/api/v1/sharing/public/token/children?${query}`)
      .expect(400);
    expect(sharing.listSharedChildren).not.toHaveBeenCalled();
  });

  it("rejects invalid child fileId before download policy or storage access", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/sharing/public/token/download")
      .send({ fileId: 0 })
      .expect(400);
    expect(sharing.findShareByToken).not.toHaveBeenCalled();
  });
});
