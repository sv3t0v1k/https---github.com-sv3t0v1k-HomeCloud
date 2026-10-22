import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { PublicFolderController } from "./public-folder.controller";
import { PublicFolderService } from "./public-folder.service";

describe("public folder HTTP boundary", () => {
  let app: INestApplication;
  const service = { authorize: jest.fn(), createFolder: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PublicFolderController],
      providers: [{ provide: PublicFolderService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix("api/v1");
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("issues proof without owner JWT and forwards password only in body", async () => {
    service.authorize.mockResolvedValue({
      proof: "signed",
      expiresAt: "2026-10-22T12:00:00Z",
    });
    await request(app.getHttpServer())
      .post("/api/v1/sharing/public/qa-token/upload-authorizations")
      .send({ password: "synthetic" })
      .expect(200);
    expect(service.authorize).toHaveBeenCalledWith("qa-token", "synthetic");
  });

  it("passes proof and idempotency key in headers and returns 201", async () => {
    const key = "11111111-1111-4111-8111-111111111111";
    service.createFolder.mockResolvedValue({
      id: 13,
      parentId: 10,
      name: "new",
    });
    await request(app.getHttpServer())
      .post("/api/v1/sharing/public/qa-token/folders")
      .set("X-Share-Upload-Proof", "signed")
      .set("Idempotency-Key", key)
      .send({ parentId: 10, name: "new" })
      .expect(201, { id: 13, parentId: 10, name: "new" });
    expect(service.createFolder).toHaveBeenCalledWith(
      "qa-token",
      "signed",
      key,
      { parentId: 10, name: "new" },
    );
  });
});
