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
import { FileEntity } from './file.entity';

@Entity('share_links')
export class ShareLinkEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 255 })
  token: string;

  @Column({ length: 255, nullable: true })
  password: string;

  @Column({ nullable: true })
  expiresAt: Date;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'bigint', default: 0 })
  downloadCount: number;

  @Column({ default: false })
  isFolder: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserEntity;

  @Column()
  userId: number;

  @ManyToOne(() => FileEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'fileId' })
  file: FileEntity;

  @Column()
  fileId: number;
}