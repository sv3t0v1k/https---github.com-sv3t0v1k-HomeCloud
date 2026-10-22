import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { PublicFolderService } from "./public-folder.service";

class PublicFolderAuthorizationDto {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  password?: string;
}

@Controller("sharing/public/:token")
export class PublicFolderController {
  constructor(private readonly folders: PublicFolderService) {}

  @Post("upload-authorizations")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  authorize(
    @Param("token") token: string,
    @Body() body: PublicFolderAuthorizationDto,
  ) {
    return this.folders.authorize(token, body?.password ?? "");
  }

  @Post("folders")
  @HttpCode(HttpStatus.CREATED)
  @Header("Cache-Control", "no-store")
  createFolder(
    @Param("token") token: string,
    @Headers("x-share-upload-proof") proof: string | undefined,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: { parentId?: unknown; name?: unknown },
  ) {
    return this.folders.createFolder(token, proof, key, body);
  }
}
