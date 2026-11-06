import { Controller, INestApplication, Post, Request, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { AuthGuard } from "@nestjs/passport";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { UserEntity } from "../entities/user.entity";
import { UpdatesController } from "../updates/updates.controller";
import { UpdatesService } from "../updates/updates.service";
import { UpdateInstallService } from "../updates/update-install.service";
import { JwtGuard } from "./guards/jwt.guard";
import { JwtStrategy, UserInfo } from "./jwt.strategy";

const secret = "failure-security-test-access-secret-at-least-32";
const mutation = jest.fn(() => ({ ok: true }));

@Controller("security-probe")
@UseGuards(JwtGuard)
class ProtectedMutationController {
  @Post()
  execute() {
    return mutation();
  }

  @Post("identity")
  identity(@Request() req: { user: UserInfo }) {
    return req.user;
  }
}

// The same Passport guard used by administrative APIs, without invoking updates.
@Controller("passport-probe")
@UseGuards(AuthGuard("jwt"))
class PassportMutationController {
  @Post()
  execute() {
    return mutation();
  }

  @Post("identity")
  identity(@Request() req: { user: UserInfo }) {
    return req.user;
  }

}

describe("Real JWT boundary rejects abusive credentials before mutation", () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret });
  const checkUpdates = jest.fn(async () => ({ available: false }));
  const isAdmin = jest.fn((userId: number) => userId === 2);
  const users = new Map<number, { id: number; email: string; isActive: boolean }>();
  const findOne = jest.fn(async ({ where }: { where: { id: number; isActive: boolean } }) => {
    const user = users.get(where.id);
    return user?.isActive === where.isActive ? user : null;
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProtectedMutationController, PassportMutationController, UpdatesController],
      providers: [
        JwtGuard,
        JwtStrategy,
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
        { provide: getRepositoryToken(UserEntity), useValue: { findOne } },
        { provide: UpdatesService, useValue: { isAdmin, check: checkUpdates } },
        { provide: UpdateInstallService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    users.clear();
    users.set(1, { id: 1, email: "owner@example.test", isActive: true });
    users.set(2, { id: 2, email: "admin@example.test", isActive: true });
  });

  describe.each(["/security-probe", "/passport-probe"])("%s", (endpoint) => {
    it.each([
      undefined,
      "",
      "Bearer",
      "Bearer invalid",
      "Basic abc",
      "Bearer a.b.c",
      `Bearer ${"a".repeat(4090)}.b.c`,
    ])("rejects malformed Authorization=%s", async (authorization) => {
      const attempt = request(app.getHttpServer()).post(endpoint);
      if (authorization !== undefined)
        attempt.set("Authorization", authorization);
      const response = await attempt.expect(401);
      expect(response.body).toEqual({ message: "Unauthorized", statusCode: 401 });
      expect(mutation).not.toHaveBeenCalled();
      expect(findOne).not.toHaveBeenCalled();
    });

    it.each(["extra-component", "double-space", "tab", "lowercase-scheme"])(
      "rejects noncanonical %s with a valid signature",
      async (kind) => {
        const token = jwt.sign({ sub: 1 }, { expiresIn: 60 });
        const headers: Record<string, string> = {
          "extra-component": `Bearer ${token} extra`,
          "double-space": `Bearer  ${token}`,
          tab: `Bearer\t${token}`,
          "lowercase-scheme": `bearer ${token}`,
        };
        await request(app.getHttpServer()).post(endpoint)
          .set("Authorization", headers[kind]).expect(401);
        expect(mutation).not.toHaveBeenCalled();
        expect(findOne).not.toHaveBeenCalled();
      },
    );

    it.each(["expired", "wrong-secret", "refresh-secret"])(
      "rejects %s signed token before mutation",
      async (kind) => {
        const token = jwt.sign(
          { sub: 1, email: "owner@example.test" },
          { secret: kind === "expired" ? secret : `${secret}-${kind}`, expiresIn: kind === "expired" ? -1 : 60 },
        );
        const response = await request(app.getHttpServer()).post(endpoint)
          .set("Authorization", `Bearer ${token}`).expect(401);
        expect(JSON.stringify(response.body)).not.toContain(token);
        expect(mutation).not.toHaveBeenCalled();
        expect(findOne).not.toHaveBeenCalled();
      },
    );

    it.each([undefined, null, "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
      "rejects signed invalid subject %s before repository access",
      async (sub) => {
        const token = jwt.sign({ sub }, { expiresIn: 60 });
        await request(app.getHttpServer()).post(endpoint)
          .set("Authorization", `Bearer ${token}`).expect(401);
        expect(findOne).not.toHaveBeenCalled();
        expect(mutation).not.toHaveBeenCalled();
      },
    );

    it.each(["deactivated", "deleted"])(
      "rejects a still-valid JWT after the user is %s",
      async (state) => {
        const token = jwt.sign({ sub: 1 }, { expiresIn: 60 });
        await request(app.getHttpServer()).post(endpoint)
          .set("Authorization", `Bearer ${token}`).expect(201);
        mutation.mockClear();
        if (state === "deleted") users.delete(1);
        else users.get(1)!.isActive = false;
        await request(app.getHttpServer()).post(endpoint)
          .set("Authorization", `Bearer ${token}`).expect(401);
        expect(findOne).toHaveBeenLastCalledWith({ where: { id: 1, isActive: true } });
        expect(mutation).not.toHaveBeenCalled();
      },
    );

    it("admits a live access token as the positive control", async () => {
      const token = jwt.sign({ sub: 1, email: "outdated@example.test" }, { expiresIn: 60 });
      await request(app.getHttpServer()).post(endpoint)
        .set("Authorization", `Bearer ${token}`).expect(201, { ok: true });
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(findOne).toHaveBeenCalledWith({ where: { id: 1, isActive: true } });
      await request(app.getHttpServer()).post(`${endpoint}/identity`)
        .set("Authorization", `Bearer ${token}`)
        .expect(201, { userId: 1, email: "owner@example.test" });
    });
  });

  it("preserves actual administrative route authorization without running updates", async () => {
    const owner = jwt.sign({ sub: 1 }, { expiresIn: 60 });
    const admin = jwt.sign({ sub: 2 }, { expiresIn: 60 });
    await request(app.getHttpServer()).get("/updates/access")
      .set("Authorization", `Bearer ${owner}`).expect(200, { admin: false });
    await request(app.getHttpServer()).get("/updates")
      .set("Authorization", `Bearer ${owner}`).expect(403);
    expect(checkUpdates).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get("/updates")
      .set("Authorization", `Bearer ${admin}`).expect(200, { available: false });
    checkUpdates.mockClear();
    isAdmin.mockClear();
    users.get(2)!.isActive = false;
    await request(app.getHttpServer()).get("/updates")
      .set("Authorization", `Bearer ${admin}`).expect(401);
    expect(isAdmin).not.toHaveBeenCalled();
    expect(checkUpdates).not.toHaveBeenCalled();
  });
});
