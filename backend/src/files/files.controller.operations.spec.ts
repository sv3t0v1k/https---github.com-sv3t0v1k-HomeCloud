import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { StorageService } from "../storage/storage.service";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";

describe("FilesController operation contracts", () => {
  let app: INestApplication;
  const service = {
    createFolder: jest.fn(),
    updateFolder: jest.fn(),
    removeFolder: jest.fn(),
    restoreFolder: jest.fn(),
    deleteFolderPermanently: jest.fn(),
    updateFile: jest.fn(),
    copyFile: jest.fn(),
    moveFile: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [
        { provide: FilesService, useValue: service },
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
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() =>
    Object.values(service).forEach((mock) =>
      mock.mockReset().mockResolvedValue({ ok: true }),
    ),
  );

  it("publishes folder lifecycle routes with FolderEntity ids", async () => {
    await request(app.getHttpServer())
      .patch("/api/v1/files/folders/7")
      .send({ name: "Renamed", parentId: 3 })
      .expect(200);
    await request(app.getHttpServer())
      .delete("/api/v1/files/folders/7")
      .expect(200);
    await request(app.getHttpServer())
      .post("/api/v1/files/folders/7/restore")
      .expect(200);
    await request(app.getHttpServer())
      .delete("/api/v1/files/folders/7/permanent")
      .expect(200);
    expect(service.updateFolder).toHaveBeenCalledWith(42, 7, {
      name: "Renamed",
      parentId: 3,
    });
    expect(service.removeFolder).toHaveBeenCalledWith(42, 7);
    expect(service.restoreFolder).toHaveBeenCalledWith(42, 7);
    expect(service.deleteFolderPermanently).toHaveBeenCalledWith(42, 7);
  });

  it("accepts intended operation DTOs under the global whitelist", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/files/folders")
      .send({ name: "Docs", parentId: 3 })
      .expect(201);
    await request(app.getHttpServer())
      .patch("/api/v1/files/11")
      .send({ name: "report.txt" })
      .expect(200);
    await request(app.getHttpServer())
      .post("/api/v1/files/11/copy")
      .send({ targetParentId: 3 })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/files/11/move")
      .send({ targetParentId: 3 })
      .expect(200);
    expect(service.createFolder).toHaveBeenCalledWith(42, "Docs", 3);
    expect(service.updateFile).toHaveBeenCalledWith(42, 11, {
      name: "report.txt",
    });
    expect(service.copyFile).toHaveBeenCalledWith(42, 11, 3);
    expect(service.moveFile).toHaveBeenCalledWith(42, 11, 3);
  });

  it("rejects unknown and invalid operation fields", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/files/folders")
      .send({ name: "Docs", ownerId: 9 })
      .expect(400);
    await request(app.getHttpServer())
      .post("/api/v1/files/11/move")
      .send({ targetParentId: 0 })
      .expect(400);
    expect(service.createFolder).not.toHaveBeenCalled();
    expect(service.moveFile).not.toHaveBeenCalled();
  });
});
