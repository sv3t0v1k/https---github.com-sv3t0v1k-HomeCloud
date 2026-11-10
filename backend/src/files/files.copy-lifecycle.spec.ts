import { EventEmitter } from "node:events";
import { BadRequestException, ExecutionContext } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { StorageService } from "../storage/storage.service";
import { FilesService } from "./files.service";
import { FilesController } from "./files.controller";

describe("File copy HTTP lifecycle", () => {
  function fixture() {
    const req = Object.assign(new EventEmitter(), {
      user: { userId: 9 },
      aborted: false,
    }) as unknown as Parameters<FilesController["copy"]>[0];

    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    }) as unknown as Parameters<FilesController["copy"]>[3];

    const files = { copyFile: jest.fn() };
    const controller = new FilesController(
      files as unknown as FilesService,
      {} as StorageService,
    );

    return { req, res, files, controller };
  }

  it("returns the copy and cleans its event listeners", async () => {
    const { req, res, files, controller } = fixture();
    files.copyFile.mockResolvedValue({ id: 12 });

    await expect(controller.copy(req, "7", {}, res)).resolves.toEqual({
      id: 12,
    });

    expect(files.copyFile).toHaveBeenCalledWith(
      9,
      7,
      undefined,
      expect.any(AbortSignal),
    );

    const signal = files.copyFile.mock.calls[0][3] as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(req.listenerCount("aborted")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);

    res.emit("close");
    expect(signal.aborted).toBe(false);
  });

  it.each(["request", "response"] as const)(
    "cancels a running operation after %s disconnect",
    async (kind) => {
      const { req, res, files, controller } = fixture();

      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });

      files.copyFile.mockImplementation(
        (
          _userId: number,
          _fileId: number,
          _parentId: number | undefined,
          signal: AbortSignal,
        ) => {
          started();
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                reject(new Error("copy cancelled"));
              },
              { once: true },
            );
          });
        },
      );

      const operation = controller.copy(req, "7", {}, res);
      await entered;

      if (kind === "request") {
        Object.assign(req, { aborted: true });
        req.emit("aborted");
      } else {
        Object.assign(res, { destroyed: true });
        res.emit("close");
      }

      await expect(operation).rejects.toThrow("copy cancelled");

      const signal = files.copyFile.mock.calls[0][3] as AbortSignal;
      expect(signal.aborted).toBe(true);
      expect(req.listenerCount("aborted")).toBe(0);
      expect(res.listenerCount("close")).toBe(0);
    },
  );

  it.each(["0", "7oops", "2147483648"])("rejects invalid ID %s", async (id) => {
    const { req, res, files, controller } = fixture();

    await expect(controller.copy(req, id, {}, res)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(files.copyFile).not.toHaveBeenCalled();
    expect(res.listenerCount("close")).toBe(0);
  });

  it("preserves Nest HTTP response serialization", async () => {
    const files = {
      copyFile: jest.fn().mockResolvedValue({ id: 12 }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [
        { provide: FilesService, useValue: files },
        { provide: StorageService, useValue: {} },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context.switchToHttp().getRequest().user = { userId: 9 };
          return true;
        },
      })
      .compile();

    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");

    try {
      await app.init();

      await request(app.getHttpServer())
        .post("/api/v1/files/7/copy")
        .send({})
        .expect(201, { id: 12 });

      expect(files.copyFile).toHaveBeenCalledWith(
        9,
        7,
        undefined,
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });
});
