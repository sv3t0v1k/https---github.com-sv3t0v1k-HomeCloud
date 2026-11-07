import {
  BadRequestException, ConflictException, Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { constants } from "fs";
import { link, lstat, open, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { dirname, isAbsolute, join } from "path";
import { UpdatesService } from "./updates.service";

const HASH = /^[a-f0-9]{64}$/;
const STATUS_FORMAT = "homecloud-update-status-v1";
const REQUEST_FORMAT = "homecloud-update-request-v1";
const STATES = new Set(["QUEUED", "RUNNING", "INSTALLED", "STOP", "MANUAL_RECOVERY_REQUIRED", "VALIDATION_REQUIRED"]);

export type InstallStatus = {
  status: string;
  manifestSha256: string | null;
  phase: string | null;
  updatedAt: string | null;
};

@Injectable()
export class UpdateInstallService {
  constructor(private readonly config: ConfigService, private readonly updates: UpdatesService) {}

  private configuredPaths(): { inbox: string; status: string } | null {
    if (this.config.get<string>("UPDATE_INSTALL_BRIDGE_ENABLED") !== "true") return null;
    // These paths are trusted operator configuration, never request-controlled.
    const inbox = this.config.get<string>("UPDATE_REQUEST_INBOX") || "";
    const status = this.config.get<string>("UPDATE_STATUS_FILE") || "";
    if (!isAbsolute(inbox) || !isAbsolute(status)) return null;
    return { inbox, status };
  }

  async status(): Promise<InstallStatus> {
    const paths = this.configuredPaths();
    if (!paths) return { status: "DISABLED", manifestSha256: null, phase: null, updatedAt: null };
    let handle: import("fs/promises").FileHandle | undefined;
    try {
      handle = await open(paths.status, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== 0 || info.gid !== 65533 ||
          (info.mode & 0o777) !== 0o640 || info.size > 4096) {
        throw new Error("Unsafe status file");
      }
      const raw = await handle.readFile({ encoding: "utf8" });
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid status");
      const v = value as Record<string, unknown>;
      if (v.format !== STATUS_FORMAT || !STATES.has(String(v.status)) ||
          typeof v.manifestSha256 !== "string" || !HASH.test(v.manifestSha256) ||
          typeof v.updatedAt !== "string" || v.updatedAt.length > 64 ||
          (v.phase !== null && (typeof v.phase !== "string" || v.phase.length > 64))) {
        throw new Error("Invalid status");
      }
      return { status: v.status as string, manifestSha256: v.manifestSha256,
        phase: v.phase as string | null, updatedAt: v.updatedAt };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        try {
          await lstat(join(dirname(paths.status), "archiving.json"));
          return { status: "UNKNOWN_REQUIRES_REVIEW", manifestSha256: null, phase: null, updatedAt: null };
        } catch (markerError) {
          if ((markerError as { code?: string }).code !== "ENOENT") {
            return { status: "UNKNOWN_REQUIRES_REVIEW", manifestSha256: null, phase: null, updatedAt: null };
          }
        }
        try {
          const request = await lstat(join(paths.inbox, "request.json"));
          if (!request.isFile() || request.isSymbolicLink() || request.uid !== 1001 ||
              request.gid !== 65533 || (request.mode & 0o777) !== 0o600 ||
              request.size < 1 || request.size > 512 || request.nlink < 1 || request.nlink > 2) {
            throw new Error("Unsafe queued request");
          }
          return { status: "QUEUED", manifestSha256: null, phase: null, updatedAt: null };
        } catch (requestError) {
          if ((requestError as { code?: string }).code !== "ENOENT") {
            return { status: "UNKNOWN_REQUIRES_REVIEW", manifestSha256: null, phase: null, updatedAt: null };
          }
        }
        return { status: "NO_JOB", manifestSha256: null, phase: null, updatedAt: null };
      }
      // Missing/corrupt permissions or malformed receipt are never treated as idle.
      return { status: "UNKNOWN_REQUIRES_REVIEW", manifestSha256: null, phase: null, updatedAt: null };
    } finally {
      await handle?.close();
    }
  }

  async submit(manifestSha256: string): Promise<InstallStatus> {
    if (typeof manifestSha256 !== "string" || !HASH.test(manifestSha256)) {
      throw new BadRequestException("Invalid manifest identity");
    }
    const paths = this.configuredPaths();
    if (!paths) throw new ServiceUnavailableException("Update installation is disabled");
    // Phase 1: TEST only. RELEASE installation has a separate, unqualified contract.
    if (this.config.get<string>("UPDATE_CHANNEL") !== "test") {
      throw new ServiceUnavailableException("Only TEST request admission is supported");
    }
    const current = await this.status();
    if (current.status !== "NO_JOB") {
      throw new ConflictException("Previous update must be reconciled first");
    }
    const check = await this.updates.check();
    if (check.channel !== "test" || check.status !== "available" || !check.available ||
        !("manifestSha256" in check.available) || check.available.manifestSha256 !== manifestSha256) {
      throw new ConflictException("No verified matching TEST build");
    }
    // Do not create the directory. It must be provisioned on the host.
    let directory;
    try {
      directory = await lstat(paths.inbox);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 ||
          directory.gid !== 65533 || (directory.mode & 0o777) !== 0o770) throw new Error("Unsafe inbox");
    } catch { throw new ServiceUnavailableException("Host inbox is not provisioned safely"); }
    const tmp = join(paths.inbox, `.request-${randomUUID()}.tmp`);
    const target = join(paths.inbox, "request.json");
    let handle: import("fs/promises").FileHandle | undefined;
    try {
      handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const body = JSON.stringify({ format: REQUEST_FORMAT, channel: "test", manifestSha256 }) + "\n";
      await handle.writeFile(body);
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Hard-link publishes only a fully written file and never replaces a pending job.
      await link(tmp, target);
      const dir = await open(
        paths.inbox,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      return { status: "QUEUED", manifestSha256, phase: null, updatedAt: null };
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        throw new ConflictException("An update request is already queued");
      }
      throw new ServiceUnavailableException("Unable to queue update safely");
    } finally {
      await handle?.close();
      await unlink(tmp).catch(() => undefined);
    }
  }
}
