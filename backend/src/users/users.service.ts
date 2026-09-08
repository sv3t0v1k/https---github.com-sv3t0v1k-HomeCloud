import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../entities/user.entity';

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

  async updateProfile(id: number, data: Partial<UserEntity>): Promise<UserEntity> {
    await this.userRepository.update(id, data);
    const user = await this.findById(id);
    if (!user) throw new Error('User not found');
    return user;
  }

  async updateStorageUsed(id: number, bytes: number): Promise<void> {
    await this.userRepository.increment({ id }, 'storageUsed', bytes);
  }

  async decrementStorageUsed(id: number, bytes: number): Promise<void> {
    await this.userRepository.decrement({ id }, 'storageUsed', bytes);
  }
}