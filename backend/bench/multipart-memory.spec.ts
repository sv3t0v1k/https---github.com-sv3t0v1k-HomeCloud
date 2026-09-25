import {
  assertSafePlan,
  collectMemorySafetyEvidence,
  percentile,
  summarizeMemory,
} from "./multipart-memory";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const healthyPressure = `The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 70%\n`;
const healthyVm = `Mach Virtual Memory Statistics: (page size of 16384 bytes).\nPages free: 10000.\nPages inactive: 400000.\nPages speculative: 10000.\nPages throttled: 0.\nPages occupied by compressor: 20000.\n`;
const noSwap =
  "vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)";
function vmWith(values: {
  free: number;
  inactive: number;
  speculative?: number;
  throttled?: number;
  compressor?: number;
}) {
  return `Mach Virtual Memory Statistics: (page size of 16384 bytes).\nPages free: ${values.free}.\nPages inactive: ${values.inactive}.\nPages speculative: ${values.speculative ?? 0}.\nPages throttled: ${values.throttled ?? 0}.\nPages occupied by compressor: ${values.compressor ?? 0}.\n`;
}
function darwin(outputs: Record<string, string>) {
  return collectMemorySafetyEvidence(
    "darwin",
    (command, args) => {
      const key = [command, ...args].join(" ");
      if (!(key in outputs)) throw new Error(`unexpected ${key}`);
      return outputs[key];
    },
    16 * GIB,
    256 * MIB,
  );
}

describe("multipart memory harness", () => {
  test("percentile детерминирован", () => {
    expect(percentile([9, 1, 5, 3], 0.5)).toBe(3);
    expect(percentile([], 0.99)).toBe(0);
  });
  test("неразрешённая цель fail closed", () => {
    const evidence = darwin({
      memory_pressure: healthyPressure,
      vm_stat: healthyVm,
      "sysctl -n hw.memsize": String(16 * GIB),
      "sysctl vm.swapusage": noSwap,
    });
    expect(() => assertSafePlan(200 * MIB, 1, evidence)).toThrow(
      "вне разрешённой матрицы",
    );
  });
  test("unsafe target получает NOT_RUN_SAFETY", () => {
    const evidence = darwin({
      memory_pressure:
        "The system has 17179869184 bytes.\nSystem-wide memory free percentage: 2%\n",
      vm_stat: vmWith({ free: 1000, inactive: 1000 }),
      "sysctl -n hw.memsize": String(16 * GIB),
      "sysctl vm.swapusage": noSwap,
    });
    expect(() => assertSafePlan(50 * MIB, 4, evidence)).toThrow(
      "NOT_RUN_SAFETY",
    );
  });
  test("низкий os.freemem не даёт ложный отказ при согласованных macOS сигналах", () => {
    const evidence = darwin({
      memory_pressure: healthyPressure,
      vm_stat: healthyVm,
      "sysctl -n hw.memsize": String(16 * GIB),
      "sysctl vm.swapusage": noSwap,
    });
    expect(evidence.osFreeBytes).toBe(256 * MIB);
    expect(() => assertSafePlan(25 * MIB, 1, evidence)).not.toThrow();
  });
  test("swap pressure закрывает gate", () => {
    const evidence = darwin({
      memory_pressure: healthyPressure,
      vm_stat: healthyVm,
      "sysctl -n hw.memsize": String(16 * GIB),
      "sysctl vm.swapusage":
        "vm.swapusage: total = 1024.00M  used = 1.00M  free = 1023.00M  (encrypted)",
    });
    expect(() => assertSafePlan(25 * MIB, 1, evidence)).toThrow(
      "NOT_RUN_SAFETY",
    );
  });
  test("сильная компрессия консервативно уменьшает headroom", () => {
    const evidence = darwin({
      memory_pressure: healthyPressure,
      vm_stat: vmWith({
        free: 10000,
        inactive: 400000,
        speculative: 10000,
        compressor: 415000,
      }),
      "sysctl -n hw.memsize": String(16 * GIB),
      "sysctl vm.swapusage": noSwap,
    });
    expect(() => assertSafePlan(25 * MIB, 1, evidence)).toThrow(
      "NOT_RUN_SAFETY",
    );
  });
  test.each([
    ["memory_pressure", "garbage"],
    ["vm_stat", "garbage"],
  ])("malformed %s fail closed", (key, malformed) => {
    expect(() =>
      darwin({
        memory_pressure:
          key === "memory_pressure" ? malformed : healthyPressure,
        vm_stat: key === "vm_stat" ? malformed : healthyVm,
        "sysctl -n hw.memsize": String(16 * GIB),
        "sysctl vm.swapusage": noSwap,
      }),
    ).toThrow();
  });
  test("ошибка обязательной команды fail closed", () => {
    expect(() =>
      collectMemorySafetyEvidence(
        "darwin",
        () => {
          throw new Error("command unavailable");
        },
        16 * GIB,
        256 * MIB,
      ),
    ).toThrow("command unavailable");
  });
  test("container headroom ограничивает host", () => {
    const evidence = {
      ...darwin({
        memory_pressure: healthyPressure,
        vm_stat: healthyVm,
        "sysctl -n hw.memsize": String(16 * GIB),
        "sysctl vm.swapusage": noSwap,
      }),
      containerLimitBytes: 512 * MIB,
      containerCurrentBytes: 400 * MIB,
      containerHeadroomBytes: 90 * MIB,
    };
    expect(() => assertSafePlan(25 * MIB, 1, evidence)).toThrow(
      "NOT_RUN_SAFETY",
    );
  });
  test("Linux path сохраняет os.freemem и cgroup без macOS команд", () => {
    const evidence = collectMemorySafetyEvidence(
      "linux",
      () => {
        throw new Error("не должен вызываться");
      },
      8 * GIB,
      3 * GIB,
    );
    expect(evidence.hostAvailableBytes).toBe(3 * GIB);
    expect(evidence.containerLimitSource).toBe("not-applicable-host-process");
  });
  test("sampler считает peaks и delta", () => {
    const base = {
      rss: 100,
      heapTotal: 0,
      heapUsed: 20,
      external: 10,
      arrayBuffers: 5,
      atMs: 0,
      active: 0,
    };
    const next = {
      ...base,
      rss: 150,
      heapUsed: 30,
      external: 40,
      arrayBuffers: 25,
      atMs: 10,
      active: 2,
    };
    expect(summarizeMemory([base, next], base).peakDelta).toEqual({
      rss: 50,
      heapUsed: 10,
      external: 30,
      arrayBuffers: 20,
    });
  });
});
