import type { AuditEvent } from './types.js';

/** Bounded labels: never include identity, tool, arguments or request IDs. */
export class GatewayMetrics {
  private counts = new Map<string, number>();
  private duration = 0;
  private completed = 0;
  record(event: AuditEvent) {
    this.counts.set(event.outcome, (this.counts.get(event.outcome) ?? 0) + 1);
    if (event.durationMs !== undefined) { this.completed++; this.duration += event.durationMs / 1000; }
  }
  render() {
    return '# TYPE gateway_events_total counter\n' + [...this.counts].map(([outcome, count]) => `gateway_events_total{outcome="${outcome}"} ${count}\n`).join('') +
      '# TYPE gateway_request_duration_seconds summary\n' +
      `gateway_request_duration_seconds_sum ${this.duration}\ngateway_request_duration_seconds_count ${this.completed}\n`;
  }
}
