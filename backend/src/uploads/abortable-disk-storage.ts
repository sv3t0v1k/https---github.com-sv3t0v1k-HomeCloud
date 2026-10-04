import { Request } from "express";
import { StorageEngine } from "multer";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { IngressRequestState } from "./chunk-ingress";

/** Multer's default disk storage leaves pending writers on an aborted multipart. */
export function abortableDiskStorage(destination: string): StorageEngine {
  return {
    _handleFile(request: Request, file, callback) {
      const filename = randomUUID();
      const target = path.join(destination, filename);
      (request as IngressRequestState).ingressFilePath = target;
      const output = fs.createWriteStream(target, { flags: "wx" });
      let completed = false;
      let failure: Error | undefined;
      const detach = () => {
        request.off("aborted", aborted);
        request.res?.off("close", aborted);
        file.stream.off("error", failed);
      };
      const failed = (error: Error) => {
        failure = error;
        output.destroy(error);
      };
      const aborted = () => {
        failure = new Error("Upload request cancelled");
        file.stream.unpipe(output);
        output.destroy(failure);
        file.stream.destroy();
      };
      request.once("aborted", aborted);
      request.res?.once("close", aborted);
      file.stream.once("error", failed);
      output.once("error", (error) => {
        failure = error;
      });
      output.once("finish", () => {
        if (failure || completed) return;
        if (request.res?.destroyed || request.res?.writableEnded) {
          aborted();
          return;
        }
        completed = true;
        detach();
        callback(null, {
          destination,
          filename,
          path: target,
          size: output.bytesWritten,
        });
      });
      output.once("close", () => {
        detach();
        if (completed) return;
        completed = true;
        fs.rm(target, { force: true }, () =>
          callback(failure ?? new Error("Upload stream closed")),
        );
      });
      if (
        request.aborted ||
        request.res?.destroyed ||
        request.res?.writableEnded
      )
        aborted();
      else file.stream.pipe(output);
    },
    _removeFile(_request, file, callback) {
      fs.unlink(file.path, callback);
    },
  };
}
