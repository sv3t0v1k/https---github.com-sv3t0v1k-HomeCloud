import {
  Controller,
  BadRequestException,
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
  @Header("Cache-Control", "private, no-store")
  @Header("Vary", "Authorization")
  async getThumbnail(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const userId = req.user.userId;
    const fileId = parsePreviewId(id);
    const controller = new AbortController();

    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };

    res.once("close", onClose);
    if (res.destroyed && !res.writableEnded) controller.abort();

    try {
      const buffer = await this.previewsService.getThumbnail(
        userId,
        fileId,
        controller.signal,
      );

      if (controller.signal.aborted || res.destroyed) return;

      res.set({
        "Content-Type": "image/png",
        "Content-Length": buffer.length,
      });
      res.send(buffer);
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      res.off("close", onClose);
    }
  }

  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  @Header("Vary", "Authorization")
  async getPreview(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    const userId = req.user.userId;
    return this.previewsService.getPreview(userId, parsePreviewId(id));
  }
}

function parsePreviewId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new BadRequestException("Invalid file ID");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new BadRequestException("Invalid file ID");
  }
  return id;
}
