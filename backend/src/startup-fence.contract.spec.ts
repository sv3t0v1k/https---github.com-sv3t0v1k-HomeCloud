import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import * as ts from "typescript";

// Execute the real entry modules with connection/bootstrap sentinels. These
// contract tests run on macOS as well; native lock semantics are covered by
// the separate Linux inherited-root-fence/runtime suites.
function evaluate(
  name: string,
  resolve: (name: string) => unknown,
  environment: Record<string, string | undefined> = {},
  platform = "linux",
) {
  const source = fs.readFileSync(path.join(__dirname, name), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled, {
    exports,
    require: resolve,
    process: { platform, env: environment },
    __dirname,
    console,
  });
  return exports;
}

describe("writer startup admission contracts", () => {
  it("main refuses an unfenced Linux entry before importing application modules", () => {
    const imports: string[] = [];
    expect(() => evaluate("main.ts", (name) => {
      imports.push(name);
      if (name === "./uploads/inherited-root-fence") {
        return { assertInheritedRootFence: () => { throw new Error("fence missing"); } };
      }
      throw new Error(`unexpected application import: ${name}`);
    })).toThrow("fence missing");
    expect(imports).toEqual(["./uploads/inherited-root-fence"]);
  });

  it("main invokes bootstrap only after its fence has passed", async () => {
    const fence = jest.fn();
    const bootstrap = jest.fn(async () => undefined);
    evaluate("main.ts", (name) => {
      if (name === "./uploads/inherited-root-fence") {
        return { assertInheritedRootFence: fence };
      }
      if (name === "./api-bootstrap") return { bootstrap };
      throw new Error(`unexpected application import: ${name}`);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fence).toHaveBeenCalledTimes(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(fence.mock.invocationCallOrder[0]).toBeLessThan(bootstrap.mock.invocationCallOrder[0]);
  });

  it("direct api-bootstrap entry has no startup side effects and its exported bootstrap is fenced", async () => {
    const create = jest.fn();
    const fence = jest.fn(() => { throw new Error("fence missing"); });
    const entry = evaluate("api-bootstrap.ts", (name) => {
      if (name === "@nestjs/core") return { NestFactory: { create } };
      if (name === "./uploads/inherited-root-fence") {
        return { assertInheritedRootFence: fence };
      }
      return {};
    });
    expect(create).not.toHaveBeenCalled();
    expect(fence).not.toHaveBeenCalled();
    await expect((entry.bootstrap as () => Promise<void>)()).rejects.toThrow("fence missing");
    expect(fence).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  function dataSourceFixture(environment: Record<string, string | undefined>, rejectFence: boolean, platform = "linux") {
    const connect = jest.fn();
    const fence = jest.fn(() => {
      if (rejectFence) throw new Error("fence missing");
    });
    class Connection {
      async initialize() {
        connect();
        return this;
      }
    }
    const entry = evaluate("data-source.ts", (name) => {
      if (name === "typeorm") return { DataSource: Connection };
      if (name === "./uploads/inherited-root-fence") {
        return { assertInheritedRootFence: fence };
      }
      return {};
    }, environment, platform);
    return { database: entry.default as Connection, connect, fence };
  }

  it.each([
    { NODE_ENV: "production" },
    { NODE_ENV: "test", HOMECLOUD_MAINTENANCE_REQUIRED: "1" },
    { NODE_ENV: "test" },
    { NODE_ENV: "development", HOMECLOUD_MAINTENANCE_REQUIRED: "0" },
    {},
  ])("CLI datasource refuses an unfenced connection in %j", async (environment) => {
    const { database, connect, fence } = dataSourceFixture(environment, true);
    await expect(database.initialize()).rejects.toThrow("fence missing");
    expect(fence).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
  });

  it("CLI datasource connects only after its inherited fence passes", async () => {
    const { database, connect, fence } = dataSourceFixture({ NODE_ENV: "production" }, false);
    await expect(database.initialize()).resolves.toBe(database);
    expect(fence).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(fence.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]);
  });

  it("macOS tooling remains usable without Linux admission", async () => {
    const { database, connect, fence } = dataSourceFixture({ NODE_ENV: "test" }, true, "darwin");
    await expect(database.initialize()).resolves.toBe(database);
    expect(fence).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
