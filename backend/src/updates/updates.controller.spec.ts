import { ForbiddenException } from "@nestjs/common";
import { UpdatesController } from "./updates.controller";
import { UpdatesService } from "./updates.service";
import { UpdateInstallService } from "./update-install.service";

describe("UpdatesController", () => {
  const check = jest.fn();
  const updates = { isAdmin: (id: number) => id === 7, check } as unknown as UpdatesService;
  const install = { status: jest.fn(), submit: jest.fn() } as unknown as UpdateInstallService;
  const controller = new UpdatesController(updates, install);
  it("does not call discovery for another authenticated user", () => {
    expect(controller.access({ user: { userId: 8 } } as never)).toEqual({ admin: false });
    expect(() => controller.check({ user: { userId: 8 } } as never)).toThrow(ForbiddenException);
    expect(check).not.toHaveBeenCalled();
  });
  it("does not read status or queue an install for a non-admin", () => {
    expect(() => controller.installationStatus({ user: { userId: 8 } } as never)).toThrow(ForbiddenException);
    expect(() => controller.requestInstallation({ user: { userId: 8 } } as never,
      { manifestSha256: "a".repeat(64) })).toThrow(ForbiddenException);
    expect(install.status).not.toHaveBeenCalled();
    expect(install.submit).not.toHaveBeenCalled();
  });
});
