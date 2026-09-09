import { NotFoundException, BadRequestException } from "@nestjs/common";
import { SharingController } from "./sharing.controller";
import * as fs from "fs";
import * as path from "path";
import { Writable } from "stream";

describe("SharingController - streaming code verification", () => {
  it("should return folder metadata for folder share", async () => {
    const mockService = {
      findShareByToken: jest.fn(),
      verifySharePassword: jest.fn(),
      incrementDownloadCount: jest.fn(),
    };

    mockService.findShareByToken.mockResolvedValue({
      token: "tok",
      password: null,
      file: {
        id: 1,
        name: "MyFolder",
        mimeType: "application/zip",
        size: 0,
        isFolder: true,
      },
    });

    const controller = new SharingController(mockService as any);
    const result = await controller.downloadShare(
      "tok",
      { password: "" },
      {} as any,
    );

    expect(result).toEqual({
      file: {
        id: 1,
        name: "MyFolder",
        mimeType: "application/zip",
        size: 0,
        isFolder: true,
      },
    });
  });

  it("should stream file data for valid public share", async () => {
    const tempFile = path.join("/tmp", `share-test-${Date.now()}.pdf`);
    fs.writeFileSync(tempFile, Buffer.from("PDF data"));

    const setMock = jest.fn();
    const writeCalls: Buffer[] = [];

    const mockRes = new Writable({
      write(chunk, encoding, callback) {
        writeCalls.push(chunk);
        callback();
      },
    }) as any;
    mockRes.set = setMock;

    const mockService = {
      findShareByToken: jest.fn(),
      verifySharePassword: jest.fn(),
      incrementDownloadCount: jest.fn(),
    };

    mockService.findShareByToken.mockResolvedValue({
      token: "tok",
      password: null,
      file: {
        id: 1,
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 9,
        isFolder: false,
        storagePath: tempFile,
      },
    });
    mockService.incrementDownloadCount.mockResolvedValue({});

    const controller = new SharingController(mockService as any);
    const promise = controller.downloadShare("tok", { password: "" }, mockRes);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await promise;

    expect(mockService.incrementDownloadCount).toHaveBeenCalledWith("tok");
    expect(setMock).toHaveBeenCalledWith({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="report.pdf"',
    });
    expect(writeCalls.length).toBeGreaterThan(0);
    expect(Buffer.concat(writeCalls).toString()).toBe("PDF data");

    fs.rmSync(tempFile, { force: true });
  });
});
