import {
  Controller,
  Get,
  Param,
  UseGuards,
  Request as NestRequest,
  Res,
  Header,
} from "@nestjs/common";
import { PreviewsService } from "./previews.service";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { Request as ExpressRequest } from "express";
import { Response } from "express";

@Controller("previews")
@UseGuards(JwtGuard)
export class PreviewsController {
  constructor(private previewsService: PreviewsService) {}

  @Get(":id/thumbnail")
  @Header("Cache-Control", "public, max-age=86400")
  async getThumbnail(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const userId = req.user.userId;
    const buffer = await this.previewsService.getThumbnail(
      userId,
      parseInt(id, 10),
    );
    res.set({
      "Content-Type": "image/png",
      "Content-Length": buffer.length,
    });
    res.send(buffer);
  }

  @Get(":id")
  async getPreview(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    const userId = req.user.userId;
    return this.previewsService.getPreview(userId, parseInt(id, 10));
  }
}
