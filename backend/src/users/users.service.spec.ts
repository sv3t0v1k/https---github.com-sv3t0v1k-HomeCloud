import { UsersService } from "./users.service";
import { UserEntity } from "../entities/user.entity";
import { NotFoundException, BadRequestException } from "@nestjs/common";

describe("UsersService - Storage Accounting", () => {
  let service: UsersService;
  let mockUserRepository: any;
  let mockExecute: jest.Mock;

  beforeEach(() => {
    mockExecute = jest.fn();

    mockUserRepository = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn(() => ({
          set: jest.fn(() => ({
            where: jest.fn(() => ({
              execute: mockExecute,
            })),
          })),
        })),
      })),
    };

    service = new UsersService(mockUserRepository);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("findById", () => {
    it("should return user when found", async () => {
      const user = { id: 1, email: "test@test.com" };
      mockUserRepository.findOne.mockResolvedValue(user);

      const result = await service.findById(1);
      expect(result).toEqual(user);
      expect(mockUserRepository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it("should return null when not found", async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      const result = await service.findById(999);
      expect(result).toBeNull();
    });
  });

  describe("updateStorageUsed", () => {
    it("should skip for zero or negative bytes", async () => {
      await service.updateStorageUsed(1, 0);
      expect(mockUserRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("should increment storageUsed within quota", async () => {
      mockExecute.mockResolvedValue({ affected: 1 });

      await service.updateStorageUsed(1, 100);
      expect(mockUserRepository.createQueryBuilder).toHaveBeenCalled();
    });
  });

  describe("decrementStorageUsed - atomic conditional update", () => {
    describe("Normal operation", () => {
      it("should decrement storageUsed when sufficient balance", async () => {
        mockExecute.mockResolvedValue({ affected: 1 });

        await service.decrementStorageUsed(1, 100);
        expect(mockUserRepository.createQueryBuilder).toHaveBeenCalled();
      });

      it("should skip for zero or negative bytes", async () => {
        await service.decrementStorageUsed(1, 0);
        expect(mockUserRepository.createQueryBuilder).not.toHaveBeenCalled();
      });
    });

    describe("User not found", () => {
      it("should throw NotFoundException", async () => {
        mockExecute.mockResolvedValue({ affected: 0 });
        mockUserRepository.findOne.mockResolvedValue(null);

        await expect(service.decrementStorageUsed(1, 100)).rejects.toThrow(NotFoundException);
      });
    });

    describe("Insufficient balance (would go negative)", () => {
      it("should throw BadRequestException", async () => {
        mockExecute.mockResolvedValue({ affected: 0 });
        mockUserRepository.findOne.mockResolvedValue({ id: 1, storageUsed: 50 });

        await expect(service.decrementStorageUsed(1, 100)).rejects.toThrow(BadRequestException);
      });
    });

    describe("Concurrent modification detected", () => {
      it("should throw BadRequestException for race condition", async () => {
        mockExecute.mockResolvedValue({ affected: 0 });
        mockUserRepository.findOne.mockResolvedValue({ id: 1, storageUsed: 100 });

        await expect(service.decrementStorageUsed(1, 50)).rejects.toThrow(BadRequestException);
      });
    });
  });
});
