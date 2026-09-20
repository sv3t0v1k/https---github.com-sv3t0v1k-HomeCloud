import { Test } from "@nestjs/testing";
import { ValidationPipe, NotFoundException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ConfigModule } from "@nestjs/config";
import request from "supertest";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { UserEntity } from "../entities/user.entity";

const CONFIG = {
  NODE_ENV: "production",
  FRONTEND_URL: "https://app.example.ru",
  JWT_SECRET: "strong-access-secret-1234567890ab",
  JWT_REFRESH_SECRET: "strong-refresh-secret-1234567890ab",
  JWT_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
};

const AUTH = { Authorization: "Bearer faketoken" };

/**
 * Phase 11.2C — regression coverage for users not-found error contracts.
 * Real controller + real UsersService + mocked repository + JwtGuard (mocked
 * JwtService). Proves HTTP semantics only; JWT cryptography is not exercised.
 */
describe("UsersController not-found contracts (Phase 11.2C)", () => {
  let app: any;
  let repo: { findOne: jest.Mock; update: jest.Mock };

  beforeAll(async () => {
    repo = { findOne: jest.fn(), update: jest.fn() };

    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [() => CONFIG] })],
      controllers: [UsersController],
      providers: [
        UsersService,
        { provide: getRepositoryToken(UserEntity), useValue: repo },
        {
          provide: JwtService,
          useValue: { verify: jest.fn(() => ({ sub: 1, email: "u@t.c" })), sign: jest.fn() },
        },
        { provide: Reflector, useValue: {} },
      ],
    }).compile();

    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => jest.clearAllMocks());

  it("GET /me existing → 200 and password is excluded", async () => {
    repo.findOne.mockResolvedValue({
      id: 1,
      email: "u@t.c",
      name: "U",
      password: "secret-hash",
    });

    const res = await request(app.getHttpServer())
      .get("/api/v1/users/me")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.password).toBeUndefined();
    expect(res.body.email).toBe("u@t.c");
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("GET /me missing → 404", async () => {
    repo.findOne.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .get("/api/v1/users/me")
      .set(AUTH);

    expect(res.status).toBe(404);
  });

  it("PATCH /me existing → 200 and password is excluded", async () => {
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({
      id: 1,
      email: "u@t.c",
      name: "New",
      password: "secret-hash",
    });

    const res = await request(app.getHttpServer())
      .patch("/api/v1/users/me")
      .set(AUTH)
      .send({ name: "New" });

    expect(res.status).toBe(200);
    expect(res.body.password).toBeUndefined();
    expect(res.body.name).toBe("New");
  });

  it("PATCH /me missing → 404", async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    repo.findOne.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .patch("/api/v1/users/me")
      .set(AUTH)
      .send({ name: "Ghost" });

    expect(res.status).toBe(404);
  });

  it("UsersService.updateProfile throws NotFoundException (not generic Error) for absent user", async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    repo.findOne.mockResolvedValue(null);

    const service = new UsersService(repo as any);
    await expect(service.updateProfile(999, { name: "Ghost" })).rejects.toThrow(
      NotFoundException,
    );
  });
});
