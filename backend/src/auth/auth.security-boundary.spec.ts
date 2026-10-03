import { Controller, INestApplication, Post, UseGuards } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { JwtGuard } from "./guards/jwt.guard";

const secret = "failure-security-test-access-secret-at-least-32";
const mutation = jest.fn(() => ({ ok: true }));

@Controller("security-probe")
@UseGuards(JwtGuard)
class ProtectedMutationController {
  @Post()
  execute() {
    return mutation();
  }
}

describe("Real JWT boundary rejects abusive credentials before mutation", () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProtectedMutationController],
      providers: [JwtGuard, { provide: JwtService, useValue: jwt }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    undefined,
    "",
    "Bearer",
    "Bearer invalid",
    "Basic abc",
    "Bearer a.b.c",
  ])("rejects malformed Authorization=%s", async (authorization) => {
    const attempt = request(app.getHttpServer()).post("/security-probe");
    if (authorization !== undefined)
      attempt.set("Authorization", authorization);
    const response = await attempt.expect(401);
    expect(response.body).toEqual({
      message: "Unauthorized",
      statusCode: 401,
    });
    expect(mutation).not.toHaveBeenCalled();
  });

  it.each(["expired", "wrong-secret", "refresh-secret"])(
    "rejects %s signed token before mutation",
    async (kind) => {
      const token = jwt.sign(
        { sub: 1, email: "owner@example.test" },
        {
          secret: kind === "expired" ? secret : `${secret}-${kind}`,
          expiresIn: kind === "expired" ? -1 : 60,
        },
      );
      const response = await request(app.getHttpServer())
        .post("/security-probe")
        .set("Authorization", `Bearer ${token}`)
        .expect(401);
      expect(JSON.stringify(response.body)).not.toContain(token);
      expect(mutation).not.toHaveBeenCalled();
    },
  );

  it("admits a live access token as the positive control", async () => {
    const token = jwt.sign(
      { sub: 1, email: "owner@example.test" },
      { expiresIn: 60 },
    );
    await request(app.getHttpServer())
      .post("/security-probe")
      .set("Authorization", `Bearer ${token}`)
      .expect(201, { ok: true });
    expect(mutation).toHaveBeenCalledTimes(1);
  });
});
