import { ExecutionContext, INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { StorageService } from "../storage/storage.service";
import { SharingController } from "./sharing.controller";
import { SharingService } from "./sharing.service";

describe("Sharing HTTP validation", () => {
  let app: INestApplication;
  const createShareLink = jest.fn().mockResolvedValue({ token: "created" });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SharingController],
      providers: [
        { provide: SharingService, useValue: { createShareLink } },
        { provide: StorageService, useValue: {} },
      ],
    }).overrideGuard(JwtGuard).useValue({
      canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest().user = { userId: 42 };
        return true;
      },
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true, forbidNonWhitelisted: true, transform: true,
    }));
    await app.init();
  });

  beforeEach(() => createShareLink.mockClear());
  afterAll(async () => app.close());

  it.each([undefined, null, 1, 3, Number.MAX_SAFE_INTEGER])(
    "accepts and forwards maxDownloads=%s through the HTTP boundary", async (maxDownloads) => {
      await request(app.getHttpServer()).post("/sharing").send({
        fileId: 7, password: "secret", expiresInDays: 7, isFolder: false, maxDownloads,
      }).expect(201);
      expect(createShareLink).toHaveBeenCalledWith(42, 7, {
        password: "secret", expiresInDays: 7, isFolder: false, maxDownloads,
      });
    },
  );

  it.each([0, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxDownloads=%s before calling the service", async (maxDownloads) => {
      await request(app.getHttpServer()).post("/sharing")
        .send({ fileId: 7, maxDownloads }).expect(400);
      expect(createShareLink).not.toHaveBeenCalled();
    },
  );

  it.each([
    {}, { fileId: -1 }, { fileId: "7" },
    { fileId: 7, password: 123 }, { fileId: 7, isFolder: "false" },
    { fileId: 7, expiresInDays: -1 }, { fileId: 7, expiresInDays: 36501 },
    { fileId: 7, unknown: true },
  ])("rejects invalid creation payload %j", async (payload) => {
    await request(app.getHttpServer()).post("/sharing").send(payload).expect(400);
    expect(createShareLink).not.toHaveBeenCalled();
  });
});
