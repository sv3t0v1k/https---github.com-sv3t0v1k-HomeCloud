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
  Request,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { JwtGuard } from '../auth/guards/jwt.guard';
import { FilesService } from './files.service';

class CreateFolderDto {
  name: string;
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

class SearchQueryDto {
  q: string;
}

@Controller('files')
@UseGuards(JwtGuard)
export class FilesController {
  constructor(private filesService: FilesService) {}

  @Get()
  async findAll(@Request() req, @Query('parentId') parentId?: string, @Query('search') search?: string) {
    const userId = req.user.userId;
    const parentIdNum = parentId ? parseInt(parentId, 10) : undefined;
    return this.filesService.findAll(userId, parentIdNum, search);
  }

  @Get('folders')
  async findFolders(@Request() req, @Query('parentId') parentId?: string) {
    const userId = req.user.userId;
    const parentIdNum = parentId ? parseInt(parentId, 10) : undefined;
    return this.filesService.findFolders(userId, parentIdNum);
  }

  @Get('trash')
  async getTrash(@Request() req) {
    const userId = req.user.userId;
    return this.filesService.getTrash(userId);
  }

  @Post('empty-trash')
  @HttpCode(HttpStatus.OK)
  async emptyTrash(@Request() req) {
    const userId = req.user.userId;
    return this.filesService.emptyTrash(userId);
  }

  @Get('search')
  async search(@Request() req, @Query('q') q?: string) {
    const userId = req.user.userId;
    if (!q) {
      throw new BadRequestException('Query parameter q is required');
    }
    return this.filesService.search(userId, q);
  }

  @Get('storage-info')
  async getStorageInfo(@Request() req) {
    const userId = req.user.userId;
    return this.filesService.getStorageInfo(userId);
  }

  @Post('folders')
  @HttpCode(HttpStatus.CREATED)
  async createFolder(@Request() req, @Body() dto: CreateFolderDto) {
    const userId = req.user.userId;
    return this.filesService.createFolder(userId, dto.name, dto.parentId);
  }

  @Get(':id')
  async findOne(@Request() req, @Param('id') id: string) {
    const userId = req.user.userId;
    return this.filesService.findOne(userId, parseInt(id, 10));
  }

  @Patch(':id')
  async update(@Request() req, @Param('id') id: string, @Body() dto: UpdateFileDto) {
    const userId = req.user.userId;
    return this.filesService.updateFile(userId, parseInt(id, 10), dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@Request() req, @Param('id') id: string) {
    const userId = req.user.userId;
    return this.filesService.removeFile(userId, parseInt(id, 10));
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  async restore(@Request() req, @Param('id') id: string) {
    const userId = req.user.userId;
    return this.filesService.restoreFile(userId, parseInt(id, 10));
  }

  @Delete(':id/permanent')
  @HttpCode(HttpStatus.OK)
  async deletePermanently(@Request() req, @Param('id') id: string) {
    const userId = req.user.userId;
    return this.filesService.deleteFilePermanently(userId, parseInt(id, 10));
  }

  @Post(':id/copy')
  @HttpCode(HttpStatus.CREATED)
  async copy(@Request() req, @Param('id') id: string, @Body() dto: CopyFileDto) {
    const userId = req.user.userId;
    return this.filesService.copyFile(userId, parseInt(id, 10), dto.targetParentId);
  }

  @Post(':id/move')
  @HttpCode(HttpStatus.OK)
  async move(@Request() req, @Param('id') id: string, @Body() dto: MoveFileDto) {
    const userId = req.user.userId;
    return this.filesService.moveFile(userId, parseInt(id, 10), dto.targetParentId);
  }
}
