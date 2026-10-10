import { bootstrapLegacyMarker } from "./storage-mount-registry";

// Operator command, never imported by AppModule. Uses the deployment root only.
if (require.main === module) {
  try {
    bootstrapLegacyMarker(process.env.STORAGE_PATH || "/storage");
    console.log("Legacy storage identity marker enrolled");
  } catch {
    console.error(
      "Storage enrollment refused; verify existing mount, UID and marker manually",
    );
    process.exitCode = 1;
  }
}
