/**
 * Minimal Prometheus text-format registry (counters and gauges).
 * Each process exposes its own numbers; scrape every API and worker process.
 */
type Labels = Record<string, string | number>;

interface Series {
  help: string;
  type: 'counter' | 'gauge';
  values: Map<string, { labels: Labels; value: number }>;
}

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

function escapeLabel(v: string | number): string {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export class Metrics {
  private readonly series = new Map<string, Series>();

  private get(name: string, type: Series['type'], help: string): Series {
    let s = this.series.get(name);
    if (!s) {
      s = { help, type, values: new Map() };
      this.series.set(name, s);
    }
    return s;
  }

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    const s = this.get(name, 'counter', help);
    const key = labelKey(labels);
    const entry = s.values.get(key);
    if (entry) entry.value += by;
    else s.values.set(key, { labels, value: by });
  }

  set(name: string, help: string, value: number, labels: Labels = {}): void {
    this.get(name, 'gauge', help).values.set(labelKey(labels), { labels, value });
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, s] of this.series) {
      lines.push(`# HELP ${name} ${s.help}`, `# TYPE ${name} ${s.type}`);
      for (const { labels, value } of s.values.values()) {
        const l = Object.entries(labels)
          .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
          .join(',');
        lines.push(`${name}${l ? `{${l}}` : ''} ${value}`);
      }
    }
    const mem = process.memoryUsage();
    lines.push(
      '# HELP process_resident_memory_bytes Resident memory size in bytes.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${mem.rss}`,
      '# HELP nodejs_heap_used_bytes V8 heap used in bytes.',
      '# TYPE nodejs_heap_used_bytes gauge',
      `nodejs_heap_used_bytes ${mem.heapUsed}`,
      '# HELP process_uptime_seconds Process uptime in seconds.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${Math.round(process.uptime())}`,
    );
    return lines.join('\n') + '\n';
  }
}
