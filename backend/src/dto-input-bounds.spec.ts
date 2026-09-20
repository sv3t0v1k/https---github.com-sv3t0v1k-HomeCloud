import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateShareDto } from "./sharing/dtos/create-share.dto";
import { CreateSessionDto } from "./uploads/dtos/create-session.dto";
import { UpdateProfileDto } from "./users/dtos/update-profile.dto";

/**
 * Phase 11.2D — input length bound regression for the three confirmed DTO gaps.
 *
 * Mirrors the global ValidationPipe options declared in main.ts:
 *   whitelist: true, forbidNonWhitelisted: true, transform: true
 * (plainToInstance == transform; validate whitelisted+forbid == global pipe).
 * Proves the new @MaxLength bounds: at-max accepted, above-max rejected.
 */
const VALIDATE_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

async function errors(dto: any, plain: any): Promise<string[]> {
  const inst = plainToInstance(dto, plain);
  const violations = await validate(inst, VALIDATE_OPTIONS);
  return violations.map((v) => v.toString());
}

describe("Phase 11.2D input bounds", () => {
  describe("CreateShareDto.password (@MaxLength 1024)", () => {
    const base = { fileId: 1, isFolder: false };

    it("at max (1024) accepted", async () => {
      const e = await errors(CreateShareDto, { ...base, password: "a".repeat(1024) });
      expect(e).toEqual([]);
    });

    it("above max (1025) rejected", async () => {
      const e = await errors(CreateShareDto, { ...base, password: "a".repeat(1025) });
      expect(e.length).toBeGreaterThan(0);
    });

    it("existing valid value accepted", async () => {
      const e = await errors(CreateShareDto, { ...base, password: "my-secret" });
      expect(e).toEqual([]);
    });
  });

  describe("CreateSessionDto.filename (@MaxLength 255)", () => {
    const base = { totalSize: 1, chunkSize: 1 };

    it("at max (255) accepted", async () => {
      const e = await errors(CreateSessionDto, { ...base, filename: "a".repeat(255) });
      expect(e).toEqual([]);
    });

    it("above max (256) rejected", async () => {
      const e = await errors(CreateSessionDto, { ...base, filename: "a".repeat(256) });
      expect(e.length).toBeGreaterThan(0);
    });

    it("existing valid value accepted", async () => {
      const e = await errors(CreateSessionDto, { ...base, filename: "report.pdf" });
      expect(e).toEqual([]);
    });
  });

  describe("UpdateProfileDto.avatar (@MaxLength 255)", () => {
    it("at max (255) accepted", async () => {
      const e = await errors(UpdateProfileDto, { avatar: "u".repeat(255) });
      expect(e).toEqual([]);
    });

    it("above max (256) rejected", async () => {
      const e = await errors(UpdateProfileDto, { avatar: "u".repeat(256) });
      expect(e.length).toBeGreaterThan(0);
    });

    it("existing valid value accepted", async () => {
      const e = await errors(UpdateProfileDto, { avatar: "https://cdn.example/avatar.png" });
      expect(e).toEqual([]);
    });
  });
});
