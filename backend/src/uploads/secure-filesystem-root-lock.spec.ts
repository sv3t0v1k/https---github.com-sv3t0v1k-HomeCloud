import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork } from "node:child_process";
import { SecureFilesystem } from "./secure-filesystem";

const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("SecureFilesystem root flock", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-root-fence-"));
  });

  afterEach(() => {
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });

  it("rejects an independently opened competing lock", () => {
    const a = new SecureFilesystem(root, fs.lstatSync(root));
    const b = new SecureFilesystem(root, fs.lstatSync(root));

    const fdA = a.directory(root);
    const fdB = b.directory(root);

    let fdAClosed = false;

    try {
      a.lock(fdA);

      expect(() => b.lock(fdB)).toThrow();

      fs.closeSync(fdA);
      fdAClosed = true;

      expect(() => b.lock(fdB)).not.toThrow();
    } finally {
      if (!fdAClosed) fs.closeSync(fdA);
      fs.closeSync(fdB);
      a.close();
      b.close();
    }
  });

  it("retains the lock until its FD closes", () => {
    const a = new SecureFilesystem(root, fs.lstatSync(root));
    const b = new SecureFilesystem(root, fs.lstatSync(root));

    const fdA = a.directory(root);
    const fdB = b.directory(root);

    let fdAClosed = false;

    try {
      a.lock(fdA);

      // Closing the wrapper is not sufficient to release
      // a lock held on an independent directory descriptor.
      a.close();

      expect(() => b.lock(fdB)).toThrow();

      fs.closeSync(fdA);
      fdAClosed = true;

      expect(() => b.lock(fdB)).not.toThrow();
    } finally {
      if (!fdAClosed) fs.closeSync(fdA);
      fs.closeSync(fdB);
      a.close();
      b.close();
    }
  });

  const terminateInheritedWorker = (pid: number): void => {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as { code?: string }).code !== "ESRCH") {
        throw error;
      }
    }
  };

  it("keeps the lock when the supervisor is SIGKILLed", async () => {
    const workerPath = path.resolve(
      __dirname,
      "../../test/secure-root-lock-inherit-worker.cjs",
    );

    const worker = fork(workerPath, [], {
      env: {
        ...process.env,
        HOMECLOUD_LOCK_TEST_ROOT: root,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    let stderr = "";
    let inheritedPid: number | undefined;

    worker.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const workerExited = new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
    });

    const ready = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Inherited lock worker timeout: " + stderr));
      }, 8000);

      worker.once("message", (message: unknown) => {
        clearTimeout(timeout);

        if (
          typeof message !== "object" ||
          message === null ||
          !("status" in message) ||
          message.status !== "CHILD_HOLDS_LOCK" ||
          !("childPid" in message) ||
          typeof message.childPid !== "number" ||
          !Number.isSafeInteger(message.childPid) ||
          message.childPid <= 0
        ) {
          reject(new Error("Invalid inherited lock worker message"));
          return;
        }

        inheritedPid = message.childPid;
        resolve(message.childPid);
      });

      worker.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Supervisor exited prematurely: ${code}/${signal} ${stderr}`,
          ),
        );
      });

      worker.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const contender = new SecureFilesystem(root, fs.lstatSync(root));
    const fd = contender.directory(root);

    try {
      inheritedPid = await ready;

      // Supervisor и дочерний процесс работают.
      expect(() => contender.lock(fd)).toThrow();

      // Уничтожаем исключительно supervisor.
      expect(worker.kill("SIGKILL")).toBe(true);
      await workerExited;

      // Потомок продолжает удерживать блокировку.
      expect(() => contender.lock(fd)).toThrow();

      // Завершаем последнего держателя.
      process.kill(inheritedPid, "SIGKILL");

      let acquired = false;

      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          contender.lock(fd);
          acquired = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      expect(acquired).toBe(true);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
      }

      if (inheritedPid !== undefined) {
        terminateInheritedWorker(inheritedPid);
      }

      await workerExited;
      fs.closeSync(fd);
      contender.close();
    }
  }, 15000);

  it("releases the lock after real worker SIGKILL", async () => {
    const worker = path.resolve(
      __dirname,
      "../../test/secure-root-lock-worker.cjs",
    );

    const child = fork(worker, [], {
      env: {
        ...process.env,
        HOMECLOUD_LOCK_TEST_ROOT: root,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    let stderr = "";

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Lock worker timeout: " + stderr));
      }, 8000);

      child.once("message", (message: unknown) => {
        clearTimeout(timeout);

        if (
          typeof message === "object" &&
          message !== null &&
          "status" in message &&
          message.status === "LOCKED"
        ) {
          resolve();
        } else {
          reject(new Error("Unexpected lock worker message"));
        }
      });

      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Lock worker exited: ${code}/${signal} ${stderr}`));
      });

      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const boundary = new SecureFilesystem(root, fs.lstatSync(root));

    const fd = boundary.directory(root);

    try {
      await ready;

      expect(() => boundary.lock(fd)).toThrow();

      expect(child.kill("SIGKILL")).toBe(true);
      await exited;

      expect(() => boundary.lock(fd)).not.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exited;
      fs.closeSync(fd);
      boundary.close();
    }
  }, 15000);
});
