import { Injectable } from "@nestjs/common";

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
interface Sample {
  count: number;
  sum: number;
  buckets: number[];
}

@Injectable()
export class MetricsService {
  private inFlight = 0;
  private samples = new Map<string, Sample>();
  start(): void {
    this.inFlight++;
  }
  finish(
    method: string,
    route: string,
    status: number,
    durationMs: number,
  ): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const safeMethod = METHODS.has(method) ? method : "OTHER";
    // Only pass static Express route templates; unknown traffic shares one series.
    const safeRoute = /^\/[-a-zA-Z0-9_/:.*]{0,150}$/.test(route)
      ? route
      : "unmatched";
    const statusClass =
      status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : "other";
    let key = `method="${safeMethod}",route="${safeRoute}",status_class="${statusClass}"`;
    if (!this.samples.has(key) && this.samples.size >= 500)
      key = 'method="OTHER",route="overflow",status_class="other"';
    const sample = this.samples.get(key) || {
      count: 0,
      sum: 0,
      buckets: BUCKETS.map(() => 0),
    };
    const seconds = Number.isFinite(durationMs)
      ? Math.max(0, durationMs / 1000)
      : 0;
    sample.count++;
    sample.sum += seconds;
    BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) sample.buckets[index]++;
    });
    this.samples.set(key, sample);
  }
  render(): string {
    const lines = [
      "# TYPE homecloud_http_requests_total counter",
      "# TYPE homecloud_http_request_duration_seconds histogram",
    ];
    for (const [labels, sample] of this.samples) {
      lines.push(`homecloud_http_requests_total{${labels}} ${sample.count}`);
      BUCKETS.forEach((bound, index) =>
        lines.push(
          `homecloud_http_request_duration_seconds_bucket{${labels},le="${bound}"} ${sample.buckets[index]}`,
        ),
      );
      lines.push(
        `homecloud_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${sample.count}`,
        `homecloud_http_request_duration_seconds_sum{${labels}} ${sample.sum}`,
        `homecloud_http_request_duration_seconds_count{${labels}} ${sample.count}`,
      );
    }
    const memory = process.memoryUsage();
    lines.push(
      "# TYPE homecloud_http_requests_in_flight gauge",
      `homecloud_http_requests_in_flight ${this.inFlight}`,
      "# TYPE homecloud_process_uptime_seconds gauge",
      `homecloud_process_uptime_seconds ${process.uptime()}`,
      "# TYPE homecloud_process_resident_memory_bytes gauge",
      `homecloud_process_resident_memory_bytes ${memory.rss}`,
      "# TYPE homecloud_process_heap_used_bytes gauge",
      `homecloud_process_heap_used_bytes ${memory.heapUsed}`,
    );
    return lines.join("\n") + "\n";
  }
}
