import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SecureFilesystem } from "./secure-filesystem";

describe("Linux descriptor filesystem", () => {
  let root: string;
  let outside: string;
  let boundary: SecureFilesystem;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-secure-fs-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "hc-outside-fs-"));
    boundary = new SecureFilesystem(root, fs.statSync(root));
  });
  afterEach(() => {
    boundary.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  it("creates, syncs, reads, publishes without overwriting, enumerates and removes", () => {
    const directory = path.join(root, "session");
    boundary.mkdir(directory);
    boundary.mkdir(directory);
    boundary.write(directory + "/stage", Buffer.from([0, 255, 3]));
    const fd = boundary.open(directory + "/stage");
    try {
      boundary.rename(directory + "/stage", directory + "/0");
      expect(fs.fstatSync(fd).ino).toBe(boundary.stat(directory + "/0").ino);
      expect(fs.readFileSync(fd)).toEqual(Buffer.from([0, 255, 3]));
      boundary.write(directory + "/other", Buffer.from("other"));
      expect(() =>
        boundary.rename(directory + "/other", directory + "/0"),
      ).toThrow();
      expect(boundary.list(directory).sort()).toEqual(["0", "other"]);
      boundary.sync(directory, true);
    } finally {
      fs.closeSync(fd);
    }
    boundary.remove(directory, true);
    expect(boundary.list(root)).toEqual([]);
  });
  it.each(["../escape", "a/../../escape", "a/../escape", "nul\0tail"])(
    "refuses uncanonical key %s",
    (key) => {
      expect(() => boundary.open(root + "/" + key, "wx")).toThrow();
      expect(fs.readdirSync(outside)).toEqual([]);
    },
  );
  it("refuses symlink ancestors and leaves, even when link points inside", () => {
    boundary.mkdir(root + "/saved");
    fs.symlinkSync(root + "/saved", root + "/link");
    expect(() => boundary.open(root + "/link/new", "wx")).toThrow();
    fs.writeFileSync(outside + "/original", "preserve");
    fs.symlinkSync(outside + "/original", root + "/leaf");
    expect(() => boundary.open(root + "/leaf")).toThrow();
    expect(() =>
      boundary.rename(root + "/leaf", root + "/link/moved"),
    ).toThrow();
    boundary.remove(root + "/leaf");
    expect(fs.readFileSync(outside + "/original", "utf8")).toBe("preserve");
  });
  it("recursive cleanup unlinks symlinks without following outside directories", () => {
    boundary.mkdir(root + "/session");
    fs.writeFileSync(outside + "/original", "preserve");
    fs.symlinkSync(outside, root + "/session/link");
    boundary.remove(root + "/session", true);
    expect(fs.readFileSync(outside + "/original", "utf8")).toBe("preserve");
    expect(() => boundary.remove(root, true)).toThrow();
  });
  it("refuses hardlinked regular files and non-regular leaves", () => {
    fs.writeFileSync(root + "/file", "preserve");
    fs.linkSync(root + "/file", outside + "/alias");
    expect(() => boundary.open(root + "/file", "rw")).toThrow();
    boundary.mkdir(root + "/directory");
    expect(() => boundary.open(root + "/directory")).toThrow();
  });
  it("refuses a substituted or symbolic root during acquisition", () => {
    expect(() => new SecureFilesystem(root, fs.statSync(outside))).toThrow(
      "changed",
    );
    fs.symlinkSync(root, outside + "/link");
    expect(
      () => new SecureFilesystem(outside + "/link", fs.statSync(root)),
    ).toThrow();
  });
  it("closes idempotently and fails closed on every later operation", () => {
    boundary.close();
    boundary.close();
    expect(() => boundary.write(root + "/new", Buffer.from("bytes"))).toThrow(
      "closed",
    );
    expect(() => boundary.list(root)).toThrow("closed");
  });
});
