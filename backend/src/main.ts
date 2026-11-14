import { assertInheritedRootFence } from "./uploads/inherited-root-fence";

// Security gate must run before importing AppModule or ConfigModule.
if (process.platform === "linux") {
  assertInheritedRootFence();
}

// Application modules are loaded only after the fence is verified.
void import("./api-bootstrap")
  .then(({ bootstrap }) => bootstrap())
  .catch((error: unknown) => {
    console.error("STOP: backend bootstrap failed", error);
    process.exitCode = 1;
  });
