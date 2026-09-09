import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request as NestRequest,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from "@nestjs/common";
import { Request as ExpressRequest } from "express";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { FilesService } from "./files.service";

class CreateFolderDto {
  name!: string;
  parentId?: number;
}

class UpdateFileDto {
  name?: string;
  parentId?: number | null;
}

class CopyFileDto {
  targetParentId?: number;
}

class MoveFileDto {
  targetParentId?: number;
}

@Controller("files")
@UseGuards(JwtGuard)
export class FilesController {
  constructor(private filesService: FilesService) {}

  @Get()
  async findAll(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Query("parentId") parentId?: string,
    @Query("search") search?: string,
  ) {
    const userId = req.user.userId;
    const parentIdNum = parentId ? parseInt(parentId, 10) : undefined;
    return this.filesService.findAll(userId, parentIdNum, search);
  }

  @Get("folders")
  async findFolders(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Query("parentId") parentId?: string,
  ) {
    const userId = req.user.userId;
    const parentIdNum = parentId ? parseInt(parentId, 10) : undefined;
    return this.filesService.findFolders(userId, parentIdNum);
  }

  @Get("trash")
  async getTrash(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
  ) {
    const userId = req.user.userId;
    return this.filesService.getTrash(userId);
  }

  @Post("empty-trash")
  @HttpCode(HttpStatus.OK)
  async emptyTrash(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
  ) {
    const userId = req.user.userId;
    return this.filesService.emptyTrash(userId);
  }

  @Get("search")
  async search(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Query("q") q?: string,
  ) {
    const userId = req.user.userId;
    if (!q) {
      throw new BadRequestException("Query parameter q is required");
    }
    return this.filesService.search(userId, q);
  }

  @Get("storage-info")
  async getStorageInfo(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
  ) {
    const userId = req.user.userId;
    return this.filesService.getStorageInfo(userId);
  }

  @Post("folders")
  @HttpCode(HttpStatus.CREATED)
  async createFolder(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Body() dto: CreateFolderDto,
  ) {
    const userId = req.user.userId;
    return this.filesService.createFolder(userId, dto.name, dto.parentId);
  }

  @Get(":id")
  async findOne(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    const userId = req.user.userId;
    return this.filesService.findOne(userId, parseInt(id, 10));
  }

  @Patch(":id")
  async update(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
    @Body() dto: UpdateFileDto,
  ) {
    const userId = req.user.userId;
    return this.filesService.updateFile(userId, parseInt(id, 10), dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  async remove(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    const userId = req.user.userId;
    return this.filesService.removeFile(userId, parseInt(id, 10));
  }

  @Post(":id/restore")
  @HttpCode(HttpStatus.OK)
  async restore(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    const userId = req.user.userId;
    return this.filesService.restoreFile(userId, parseInt(id, 10));
  }

  @Delete(":id/permanent")
  @HttpCode(HttpStatus.OK)
  async deletePermanently(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    const userId = req.user.userId;
    return this.filesService.deleteFilePermanently(userId, parseInt(id, 10));
  }

  @Post(":id/copy")
  @HttpCode(HttpStatus.CREATED)
  async copy(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
    @Body() dto: CopyFileDto,
  ) {
    const userId = req.user.userId;
    return this.filesService.copyFile(
      userId,
      parseInt(id, 10),
      dto.targetParentId,
    );
  }

  @Post(":id/move")
  @HttpCode(HttpStatus.OK)
  async move(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
    @Body() dto: MoveFileDto,
  ) {
    const userId = req.user.userId;
    return this.filesService.moveFile(
      userId,
      parseInt(id, 10),
      dto.targetParentId,
    );
  }
}
