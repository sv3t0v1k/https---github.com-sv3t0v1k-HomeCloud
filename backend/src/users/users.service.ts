import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, EntityManager } from "typeorm";
import { UserEntity } from "../entities/user.entity";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

  async findById(id: number): Promise<UserEntity | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepository.findOne({ where: { email } });
  }

  async updateProfile(
    id: number,
    data: Partial<UserEntity>,
  ): Promise<UserEntity> {
    await this.userRepository.update(id, data);
    const user = await this.findById(id);
    if (!user) throw new Error("User not found");
    return user;
  }

  async updateStorageUsed(
    id: number,
    bytes: number,
    manager?: EntityManager,
  ): Promise<void> {
    if (bytes <= 0) {
      return;
    }

    const repository = manager
      ? manager.getRepository(UserEntity)
      : this.userRepository;

    const result = await repository
      .createQueryBuilder()
      .update(UserEntity)
      .set({ storageUsed: () => `"storageUsed" + ${bytes}` })
      .where('id = :id AND "storageUsed" + :bytes <= "storageQuota"', {
        id,
        bytes,
      })
      .execute();

    if (result.affected === 0) {
      const user = await repository.findOne({ where: { id } });
      if (user && user.storageUsed + bytes > user.storageQuota) {
        throw new ForbiddenException("Storage quota exceeded");
      }
    }
  }

  async decrementStorageUsed(
    id: number,
    bytes: number,
    manager?: EntityManager,
  ): Promise<void> {
    if (bytes <= 0) {
      return;
    }

    const repository = manager
      ? manager.getRepository(UserEntity)
      : this.userRepository;

    const result = await repository
      .createQueryBuilder()
      .update(UserEntity)
      .set({ storageUsed: () => `"storageUsed" - ${bytes}` })
      .where('id = :id AND "storageUsed" >= :bytes', { id, bytes })
      .execute();

    if (result.affected === 0) {
      const user = await repository.findOne({ where: { id } });
      if (!user) {
        throw new NotFoundException("User not found");
      }
      if (user.storageUsed < bytes) {
        throw new BadRequestException(
          "Storage used would go negative — data inconsistency detected",
        );
      }
      throw new BadRequestException(
        "Concurrent storage modification — please retry",
      );
    }
  }
}
