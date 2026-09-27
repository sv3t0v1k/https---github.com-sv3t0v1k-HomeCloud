import {
  ExecutionContext,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { StorageService } from "../storage/storage.service";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";

describe("FilesController folder metadata", () => {
  let app: INestApplication;
  const findFolder = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [
        { provide: FilesService, useValue: { findFolder } },
        { provide: StorageService, useValue: {} },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          if (!req.headers.authorization) throw new UnauthorizedException();
          req.user = { userId: 42 };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    findFolder.mockReset();
    findFolder.mockImplementation(async (userId: number, id: number) => {
      if (userId !== 42 || id !== 7) throw new NotFoundException("Folder not found");
      return { id: 7, userId: 42, name: "Documents", parentId: null };
    });
  });

  it("returns metadata for an owned active folder", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/files/folders/7")
      .set("Authorization", "Bearer owner")
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          id: 7,
          userId: 42,
          name: "Documents",
          parentId: null,
        });
      });
    expect(findFolder).toHaveBeenCalledWith(42, 7);
  });

  it("rejects an unauthenticated metadata request", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/files/folders/7")
      .expect(401);
    expect(findFolder).not.toHaveBeenCalled();
  });

  it("uses the same 404 for a missing or inaccessible folder", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/files/folders/8")
      .set("Authorization", "Bearer owner")
      .expect(404);
    expect(findFolder).toHaveBeenCalledWith(42, 8);
  });

  it.each(["0", "abc", "12junk", "9007199254740992"])(
    "rejects invalid folder id %s without reaching the service",
    async (id) => {
      await request(app.getHttpServer())
        .get(`/api/v1/files/folders/${id}`)
        .set("Authorization", "Bearer owner")
        .expect(400);
      expect(findFolder).not.toHaveBeenCalled();
    },
  );
});
