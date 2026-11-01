import { INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import request from "supertest";
import { AuthService } from "../auth/auth.service";
import { LocalStrategy } from "../auth/local.strategy";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { UserEntity } from "../entities/user.entity";
import { UpdatesModule } from "./updates.module";
import { UpdatesService } from "./updates.service";

describe("UpdatesModule DI and HTTP access", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let adminActive = true;
  const check = jest.fn().mockResolvedValue({ status: "current" });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET: "updates-di-test-secret", UPDATE_ADMIN_USER_ID: "7" })],
        }),
        UpdatesModule,
      ],
    })
      .overrideProvider(getRepositoryToken(UserEntity)).useValue({
        findOne: jest.fn(async ({ where }: { where: { id: number; isActive: boolean } }) =>
          where.id === 7 && !adminActive ? null :
            { id: where.id, email: "user@example.test", isActive: true }),
      })
      .overrideProvider(getRepositoryToken(RefreshTokenEntity)).useValue({})
      .overrideProvider(AuthService).useValue({})
      .overrideProvider(LocalStrategy).useValue({})
      .compile();

    jwt = module.get(JwtService);
    jest.spyOn(module.get(UpdatesService), "check").mockImplementation(check);
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => app?.close());
  beforeEach(() => { check.mockClear(); adminActive = true; });

  const token = (userId: number) => `Bearer ${jwt.sign({ sub: userId, email: "user@example.test" })}`;

  it("starts with the configured AuthModule and accepts an admin JWT", async () => {
    await request(app.getHttpServer()).get("/updates").set("Authorization", token(7))
      .expect(200, { status: "current" });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "Bearer invalid"])("rejects missing or invalid JWT: %s", async (authorization) => {
    const attempt = request(app.getHttpServer()).get("/updates");
    if (authorization) attempt.set("Authorization", authorization);
    await attempt.expect(401);
    expect(check).not.toHaveBeenCalled();
  });

  it("denies update discovery to an authenticated non-admin", async () => {
    await request(app.getHttpServer()).get("/updates").set("Authorization", token(8))
      .expect(403);
    expect(check).not.toHaveBeenCalled();
  });

  it("rejects a token after the admin account is deactivated", async () => {
    adminActive = false;
    await request(app.getHttpServer()).post("/updates/installations")
      .set("Authorization", token(7)).send({ manifestSha256: "a".repeat(64) }).expect(401);
    await request(app.getHttpServer()).get("/updates/installations/current")
      .set("Authorization", token(7)).expect(401);
  });
});
