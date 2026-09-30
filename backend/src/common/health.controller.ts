import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { promises as fs } from "fs";
import * as path from "path";

interface ProbeClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

@Controller("health")
export class HealthController {
  private pending?: Promise<Record<string, string>>;
  private cached?: { checks: Record<string, string>; until: number };
  constructor(
    @InjectDataSource() private dataSource: DataSource,
    private configService: ConfigService,
  ) {}

  @Get()
  check() {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  @Get("live")
  live() {
    return this.check();
  }

  @Get("ready")
  async ready(): Promise<unknown> {
    const checks = await this.dependencies();
    if (Object.values(checks).some((value) => value !== "ok")) {
      throw new HttpException(
        { status: "not_ready", checks },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: "ready", checks };
  }

  private dependencies(): Promise<Record<string, string>> {
    if (this.cached && this.cached.until > Date.now())
      return Promise.resolve(this.cached.checks);
    if (this.pending) return this.bounded(this.pending);
    this.pending = Promise.all([this.database(), this.storage()])
      .then(([database, storage]) => {
        const checks = { database, storage };
        this.cached = { checks, until: Date.now() + 1000 };
        return checks;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.bounded(this.pending);
  }

  private bounded(
    probe: Promise<Record<string, string>>,
  ): Promise<Record<string, string>> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ database: "unavailable", storage: "unavailable" }),
        3000,
      );
      probe.then((checks) => {
        clearTimeout(timer);
        resolve(checks);
      });
    });
  }

  private async database(): Promise<string> {
    let client: ProbeClient | undefined;
    try {
      // Dedicated bounded connection: does not queue behind the application's pool.
      const driver = this.dataSource.driver as unknown as {
        postgres: {
          Client: new (options: Record<string, unknown>) => ProbeClient;
        };
      };
      const options = this.dataSource.options as unknown as Record<
        string,
        unknown
      >;
      client = new driver.postgres.Client({
        connectionString: options.url,
        host: options.host,
        port: options.port,
        user: options.username,
        password: options.password,
        database: options.database,
        ssl: options.ssl,
        connectionTimeoutMillis: 1000,
        query_timeout: 1500,
        options: "-c statement_timeout=1000",
        application_name: "homecloud-readiness",
      });
      await client.connect();
      await client.query("SELECT 1");
      return "ok";
    } catch {
      return "unavailable";
    } finally {
      if (client) await client.end().catch(() => undefined);
    }
  }

  private async storage(): Promise<string> {
    const root = path.resolve(
      this.configService.get<string>("STORAGE_PATH") || "/storage",
    );
    try {
      await this.probeDirectory(root);
      await this.probeDirectory(path.join(root, ".tmp"));
      return "ok";
    } catch {
      return "unavailable";
    }
  }

  private async probeDirectory(directory: string): Promise<void> {
    if (!(await fs.stat(directory)).isDirectory())
      throw new Error("storage unavailable");
    // mkdtemp is exclusive; cleanup can only touch this probe's own artifacts.
    const probe = await fs.mkdtemp(path.join(directory, ".health-"));
    const file = path.join(probe, "probe");
    try {
      await fs.writeFile(file, "homecloud-health", { flag: "wx", mode: 0o600 });
      if ((await fs.readFile(file, "utf8")) !== "homecloud-health")
        throw new Error("storage unavailable");
    } finally {
      await fs.unlink(file).catch((error: { code?: string }) => {
        if (error.code !== "ENOENT") throw error;
      });
      await fs.rmdir(probe);
    }
  }
}
