import * as path from "node:path";
import { ConfigService } from "@nestjs/config";
import { SSD_UPLOAD_WORKSPACE } from "../entities/upload-workspace.entity";
import { ApprovedRoot, validateRoot } from "./storage-mount-registry";

/** Optional operator configuration. No DB/API path can enroll a filesystem. */
export function ssdUploadBinding(
  config: ConfigService,
  permanentRoot: string,
): ApprovedRoot | undefined {
  const keys = [
    "UPLOAD_SSD_PATH",
    "UPLOAD_SSD_MOUNT_SOURCE",
    "UPLOAD_SSD_MOUNT_ROOT",
    "UPLOAD_SSD_FS_TYPE",
  ];
  const values = keys.map((key) => config.get<unknown>(key));
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => typeof value !== "string" || !value))
    throw new Error("Incomplete temporary SSD configuration");
  const [root, source, filesystemRoot, filesystemType] = values as string[];
  validateRoot(root);
  if (
    root === permanentRoot ||
    root.startsWith(permanentRoot + path.sep) ||
    permanentRoot.startsWith(root + path.sep)
  )
    throw new Error(
      "Temporary SSD and permanent storage roots must be disjoint",
    );
  if (
    !path.isAbsolute(source) ||
    source !== path.resolve(source) ||
    source.includes("\0") ||
    !path.isAbsolute(filesystemRoot) ||
    filesystemRoot !== path.resolve(filesystemRoot) ||
    filesystemRoot.includes("\0") ||
    !["ext4", "xfs"].includes(filesystemType)
  )
    throw new Error("Invalid temporary SSD mount mapping");
  return {
    ...SSD_UPLOAD_WORKSPACE,
    root,
    writable: true,
    profile: "trusted-upload",
    requireMount: true,
    requireMarker: true,
    expectedMount: { source, filesystemRoot, filesystemType },
  };
}
