import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

@Entity('upload_sessions')
export class UploadSessionEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 255 })
  uploadId: string;

  @Column({ length: 255 })
  filename: string;

  @Column({ type: 'bigint' })
  totalSize: number;

  @Column({ type: 'bigint', default: 0 })
  uploadedSize: number;

  @Column({ type: 'int', default: 0 })
  chunkSize: number;

  @Column({ type: 'int', default: 0 })
  totalChunks: number;

  @Column({ type: 'json', default: '[]' })
  uploadedChunks: number[];

  @Column({ length: 500 })
  tempPath: string;

  @Column({ length: 255, nullable: true })
  parentId: number;

  @Column({ default: 'pending' })
  status: string;

  @Column({ nullable: true })
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserEntity;

  @Column()
  userId: number;
}