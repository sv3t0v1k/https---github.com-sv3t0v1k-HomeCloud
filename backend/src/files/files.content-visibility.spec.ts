import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Repository } from "typeorm";

import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { FilesService } from "./files.service";

describe("FilesService visible content boundary", () => {
  const original = {
    id: 5,
    userId: 7,
    name: "picture.png",
    parentId: null,
    isDeleted: false,
    isFolder: false,
    storagePath: "/storage/picture.png",
  } as FileEntity;

  let currentFile: FileEntity | null;
  let active: boolean;
  let visible: boolean;
  let failureCode: string | null;

  const query = jest.fn(async (sql: string) => {
    if (sql.startsWith("SET LOCAL ")) return [];
    if (sql.includes("WITH RECURSIVE ancestor_chain")) {
      return [{ visible }];
    }
    if (sql.includes("SELECT id FROM users")) {
      if (failureCode !== null) {
        throw Object.assign(
          new Error("PostgreSQL query interrupted"),
          { driverError: { code: failureCode } },
        );
      }
      return active ? [{ id: 7 }] : [];
    }
    throw new Error("Unexpected SQL");
  });

  const findOne = jest.fn(async (): Promise<FileEntity | null> =>
    currentFile,
  );

  const manager = { query, findOne };
  const transaction = jest.fn(async <T>(
    callback: (value: typeof manager) => Promise<T>,
  ): Promise<T> => callback(manager));

  const service = new FilesService(
    { manager: { transaction } } as unknown as Repository<FileEntity>,
    {} as Repository<FolderEntity>,
    {} as StorageService,
    {} as UsersService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    currentFile = { ...original };
    active = true;
    visible = true;
    failureCode = null;
  });

  it("allows the owner to access an active root-level file", async () => {
    const access = jest.fn((file: FileEntity) => file.name);

    await expect(
      service.withVisibleContentFile(7, 5, access),
    ).resolves.toBe("picture.png");

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith(FileEntity, {
      where: { id: 5, userId: 7, isDeleted: false },
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.slice(0, 2).map(([sql]) => sql))
      .toEqual([
        "SET LOCAL lock_timeout = '1500ms'",
        "SET LOCAL statement_timeout = '2500ms'",
      ]);
    expect(access).toHaveBeenCalledTimes(1);
  });

  it("checks ancestors before accessing a nested file", async () => {
    currentFile = { ...original, parentId: 42 };
    const access = jest.fn(() => "allowed");

    await expect(
      service.withVisibleContentFile(7, 5, access),
    ).resolves.toBe("allowed");

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[3][0])
      .toContain("WITH RECURSIVE ancestor_chain");
    expect(access).toHaveBeenCalledTimes(1);
  });

  it("rejects invisible ancestors without accessing content", async () => {
    currentFile = { ...original, parentId: 42 };
    visible = false;
    const access = jest.fn();

    await expect(
      service.withVisibleContentFile(7, 5, access),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(access).not.toHaveBeenCalled();
  });

  it("rejects deleted files without accessing content", async () => {
    currentFile = { ...original, isDeleted: true };
    const access = jest.fn();

    await expect(
      service.withVisibleContentFile(7, 5, access),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(access).not.toHaveBeenCalled();
  });

  it("rejects inactive owners without querying file metadata", async () => {
    active = false;
    const access = jest.fn();

    await expect(
      service.withVisibleContentFile(7, 5, access),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(findOne).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
  });

  it("rejects cross-user and missing files", async () => {
    currentFile = null;
    const access = jest.fn();

    await expect(
      service.withVisibleContentFile(8, 5, access),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(access).not.toHaveBeenCalled();
  });

  it("rejects folder records", async () => {
    currentFile = { ...original, isFolder: true };
    const access = jest.fn();

    await expect(
      service.withVisibleContentFile(7, 5, access),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(access).not.toHaveBeenCalled();
  });

  it("keeps the transaction open until the access callback settles", async () => {
    let release!: () => void;
    const pending = new Promise<string>((resolve) => {
      release = () => resolve("opened");
    });

    const result = service.withVisibleContentFile(
      7, 5, async () => pending,
    );

    await Promise.resolve();
    expect(transaction).toHaveBeenCalledTimes(1);

    release();
    await expect(result).resolves.toBe("opened");
  });

  it.each(["55P03", "57014"])(
    "rejects blocked content access with HTTP 503: %s",
    async (code) => {
      failureCode = code;
      const access = jest.fn();

      await expect(
        service.withVisibleContentFile(7, 5, access),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(query.mock.calls.map(([sql]) => sql)).toEqual([
        "SET LOCAL lock_timeout = '1500ms'",
        "SET LOCAL statement_timeout = '2500ms'",
        'SELECT id FROM users WHERE id=$1 AND "isActive"=TRUE FOR SHARE',
      ]);
      expect(findOne).not.toHaveBeenCalled();
      expect(access).not.toHaveBeenCalled();
    },
  );

});
