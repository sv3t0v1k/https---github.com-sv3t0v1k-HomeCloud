import { ForbiddenException } from "@nestjs/common";
import { UpdatesController } from "./updates.controller";
import { UpdatesService } from "./updates.service";

describe("UpdatesController", () => {
  const check = jest.fn();
  const updates = { isAdmin: (id: number) => id === 7, check } as unknown as UpdatesService;
  const controller = new UpdatesController(updates);
  it("does not call discovery for another authenticated user", () => {
    expect(controller.access({ user: { userId: 8 } } as never)).toEqual({ admin: false });
    expect(() => controller.check({ user: { userId: 8 } } as never)).toThrow(ForbiddenException);
    expect(check).not.toHaveBeenCalled();
  });
});
