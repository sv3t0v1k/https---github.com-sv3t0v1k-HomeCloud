import {
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { Repository } from "typeorm";

import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { FilesService } from "./files.service";

describe("FilesService removeFile locking", () => {
  const original = {
    id: 5,
    userId: 7,
    isFolder: false,
    isDeleted: false,
  } as FileEntity;

  const runner = {
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    manager: {
      query: jest.fn(async (
        _sql: string,
        _values: unknown[],
      ): Promise<Array<{ id: number }>> => []),
      findOne: jest.fn(async (
        _entity: unknown,
        _options: unknown,
      ): Promise<FileEntity | null> => null),
      save: jest.fn(async (file: FileEntity) => file),
    },
  };

  const service = new FilesService(
    {
      manager: {
        connection: { createQueryRunner: jest.fn(() => runner) },
      },
    } as unknown as Repository<FileEntity>,
    {} as Repository<FolderEntity>,
    {} as StorageService,
    {} as UsersService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    runner.manager.query.mockResolvedValue([{ id: 7 }]);
    runner.manager.findOne.mockResolvedValue({ ...original });
  });

  it("locks owner before file and commits the deletion", async () => {
    const order: string[] = [];

    runner.manager.query.mockImplementationOnce(async () => {
      order.push("owner");
      return [{ id: 7 }];
    });
    runner.manager.findOne.mockImplementationOnce(async () => {
      order.push("file");
      return { ...original };
    });
    runner.manager.save.mockImplementationOnce(async (file) => {
      order.push("save");
      return file;
    });
    runner.commitTransaction.mockImplementationOnce(async () => {
      order.push("commit");
    });

    await expect(service.removeFile(7, 5)).resolves.toEqual({
      message: "File moved to trash",
    });

    expect(order).toEqual(["owner", "file", "save", "commit"]);
    expect(runner.manager.query).toHaveBeenCalledWith(
      "SELECT id FROM users WHERE id=$1 FOR UPDATE",
      [7],
    );
    expect(runner.manager.findOne).toHaveBeenCalledWith(
      FileEntity,
      {
        where: { id: 5, userId: 7 },
        lock: { mode: "pessimistic_write" },
      },
    );
    expect(runner.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        isDeleted: true,
        deletedAt: expect.any(Date),
      }),
    );
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it("rejects missing owner and rolls back", async () => {
    runner.manager.query.mockResolvedValueOnce([]);

    await expect(service.removeFile(7, 5))
      .rejects.toBeInstanceOf(NotFoundException);

    expect(runner.manager.findOne).not.toHaveBeenCalled();
    expect(runner.manager.save).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing file without writing", async () => {
    runner.manager.findOne.mockResolvedValueOnce(null);

    await expect(service.removeFile(7, 5))
      .rejects.toBeInstanceOf(NotFoundException);

    expect(runner.manager.save).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it("does not delete folder records", async () => {
    runner.manager.findOne.mockResolvedValueOnce({
      ...original,
      isFolder: true,
    });

    await expect(service.removeFile(7, 5))
      .rejects.toBeInstanceOf(BadRequestException);

    expect(runner.manager.save).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("rolls back a failed metadata write", async () => {
    runner.manager.save.mockRejectedValueOnce(
      new Error("database write failed"),
    );

    await expect(service.removeFile(7, 5))
      .rejects.toThrow("database write failed");

    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it("releases connection when transaction start fails", async () => {
    runner.startTransaction.mockRejectedValueOnce(
      new Error("transaction unavailable"),
    );

    await expect(service.removeFile(7, 5))
      .rejects.toThrow("transaction unavailable");

    expect(runner.manager.query).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});
