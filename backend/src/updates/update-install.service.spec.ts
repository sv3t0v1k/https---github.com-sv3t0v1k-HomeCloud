import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as fs from "fs/promises";
import { UpdateInstallService } from "./update-install.service";
import { UpdatesService } from "./updates.service";

jest.mock("fs/promises", () => ({
  ...jest.requireActual("fs/promises"),
  __esModule: true,
  lstat: jest.fn(), open: jest.fn(), link: jest.fn(), unlink: jest.fn(),
}));

const hash = "a".repeat(64);
const noJob = { status: "NO_JOB", manifestSha256: null, phase: null, updatedAt: null };
const configured = (key: string) => ({
  UPDATE_INSTALL_BRIDGE_ENABLED: "true",
  UPDATE_CHANNEL: "test",
  UPDATE_REQUEST_INBOX: "/var/lib/homecloud-update/inbox",
  UPDATE_STATUS_FILE: "/var/lib/homecloud-update/status/current.json",
} as Record<string, string>)[key] || "";

describe("UpdateInstallService — admission-only", () => {
  beforeEach(() => jest.resetAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it("is disabled by default, without reading or writing the host", async () => {
    const updates = { check: jest.fn() } as unknown as UpdatesService;
    const service = new UpdateInstallService({ get: () => "" } as unknown as ConfigService, updates);
    await expect(service.status()).resolves.toMatchObject({ status: "DISABLED" });
    await expect(service.submit(hash)).rejects.toThrow(ServiceUnavailableException);
    expect(updates.check).not.toHaveBeenCalled();
  });

  it("rejects an invalid manifest digest", async () => {
    const service = new UpdateInstallService({ get: configured } as unknown as ConfigService, {} as UpdatesService);
    await expect(service.submit("../request.json")).rejects.toThrow(BadRequestException);
  });

  it("treats group-writable or wrong-group receipts as unsafe", async () => {
    const service = new UpdateInstallService({ get: configured } as unknown as ConfigService, {} as UpdatesService);
    const stat = jest.fn().mockResolvedValue({ isFile: () => true, uid: 0, gid: 65533,
      mode: 0o660, size: 120 });
    const readFile = jest.fn();
    jest.spyOn(fs, "open").mockResolvedValue({ stat, readFile, close: jest.fn() } as never);
    await expect(service.status()).resolves.toMatchObject({ status: "UNKNOWN_REQUIRES_REVIEW" });
    stat.mockResolvedValue({ isFile: () => true, uid: 0, gid: 1001, mode: 0o640, size: 120 });
    await expect(service.status()).resolves.toMatchObject({ status: "UNKNOWN_REQUIRES_REVIEW" });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("blocks a new request while archival is incomplete", async () => {
    const service = new UpdateInstallService({ get: configured } as unknown as ConfigService, {} as UpdatesService);
    jest.spyOn(fs, "open").mockRejectedValue({ code: "ENOENT" });
    jest.spyOn(fs, "lstat").mockResolvedValue({ isFile: () => true } as never);
    await expect(service.status()).resolves.toMatchObject({ status: "UNKNOWN_REQUIRES_REVIEW" });
  });

  it("reports an admitted inbox request as queued before the receipt appears", async () => {
    const service = new UpdateInstallService({ get: configured } as unknown as ConfigService, {} as UpdatesService);
    jest.spyOn(fs, "open").mockRejectedValue({ code: "ENOENT" });
    jest.spyOn(fs, "lstat")
      .mockRejectedValueOnce({ code: "ENOENT" })
      .mockResolvedValueOnce({ isFile: () => true, isSymbolicLink: () => false,
        uid: 1001, gid: 65533, mode: 0o600, size: 120, nlink: 1 } as never);
    await expect(service.status()).resolves.toMatchObject({ status: "QUEUED" });
  });

  it("refuses a matching request while previous work needs review", async () => {
    const updates = { check: jest.fn() } as unknown as UpdatesService;
    const service = new UpdateInstallService({ get: configured } as unknown as ConfigService, updates);
    jest.spyOn(service, "status").mockResolvedValue({ ...noJob, status: "MANUAL_RECOVERY_REQUIRED" });
    await expect(service.submit(hash)).rejects.toThrow(ConflictException);
    expect(updates.check).not.toHaveBeenCalled();
  });

  it("requires operator reconciliation even after an INSTALLED receipt", async () => {
    const updates = { check: jest.fn() } as unknown as UpdatesService;
    const service = new UpdateInstallService({ get: configured } as unknown as ConfigService, updates);
    jest.spyOn(service, "status").mockResolvedValue({ ...noJob, status: "INSTALLED" });
    await expect(service.submit(hash)).rejects.toThrow(ConflictException);
    expect(updates.check).not.toHaveBeenCalled();
  });

  it("only publishes an immutable identity for the verified TEST candidate", async () => {
    const updates = { check: jest.fn().mockResolvedValue({
      channel: "test", status: "available", available: { manifestSha256: hash },
    }) } as unknown as UpdatesService;
    const service = new UpdateInstallService({ get: configured } as unknown as ConfigService, updates);
    jest.spyOn(service, "status").mockResolvedValue(noJob);
    jest.spyOn(fs, "lstat").mockResolvedValue({
      isDirectory: () => true, isSymbolicLink: () => false, uid: 0, gid: 65533, mode: 0o770,
    } as never);
    const writeFile = jest.fn();
    const sync = jest.fn();
    const close = jest.fn();
    jest.spyOn(fs, "open").mockResolvedValue({ writeFile, sync, close } as never);
    const publish = jest.spyOn(fs, "link").mockResolvedValue(undefined);
    jest.spyOn(fs, "unlink").mockResolvedValue(undefined);
    await expect(service.submit(hash)).resolves.toMatchObject({ status: "QUEUED", manifestSha256: hash });
    expect(writeFile).toHaveBeenCalledWith(JSON.stringify({
      format: "homecloud-update-request-v1", channel: "test", manifestSha256: hash,
    }) + "\n");
    expect(sync).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][1]).toBe("/var/lib/homecloud-update/inbox/request.json");
  });


  it("fails closed when directory fsync fails after publishing the request", async () => {
    const updates = { check: jest.fn().mockResolvedValue({
      channel: "test", status: "available",
      available: { manifestSha256: hash },
    }) } as unknown as UpdatesService;
    const service = new UpdateInstallService(
      { get: configured } as unknown as ConfigService, updates,
    );

    jest.spyOn(service, "status").mockResolvedValue(noJob);
    jest.spyOn(fs, "lstat").mockResolvedValue({
      isDirectory: () => true, isSymbolicLink: () => false,
      uid: 0, gid: 65533, mode: 0o770,
    } as never);

    const directorySync = jest.fn().mockRejectedValue(new Error("simulated fsync failure"));
    jest.spyOn(fs, "open")
      .mockResolvedValueOnce({
        writeFile: jest.fn(), sync: jest.fn(), close: jest.fn(),
      } as never)
      .mockResolvedValueOnce({
        sync: directorySync, close: jest.fn(),
      } as never);

    const publish = jest.spyOn(fs, "link").mockResolvedValue(undefined);
    const remove = jest.spyOn(fs, "unlink").mockResolvedValue(undefined);

    await expect(service.submit(hash)).rejects.toThrow(ServiceUnavailableException);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(directorySync).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toContain(".request-");
    expect(remove.mock.calls[0][0]).not.toContain("/request.json");
  });

  it("rejects an unsupported RELEASE install even when bridge is configured", async () => {
    const cfg = { get: (key: string) => key === "UPDATE_CHANNEL" ? "release" : configured(key) } as ConfigService;
    const service = new UpdateInstallService(cfg, {} as UpdatesService);
    await expect(service.submit(hash)).rejects.toThrow(ServiceUnavailableException);
  });
});
