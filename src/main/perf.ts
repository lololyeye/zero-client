export interface ProcMetric {
  pid: number;
  type: string;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number };
}

export interface PerfSnapshot {
  ramMb: number;
  cpuPercent: number;
  processes: { type: string; ramMb: number; cpu: number }[];
  gpu: string;
  startupMs: number | null;
  profile: 'balanced' | 'lightweight' | 'custom';
  activeModules: string[];
  background: string[];
  at: number;
}

/** Aggregate Electron app metrics (workingSetSize is KB). */
export function summarizeMetrics(metrics: ProcMetric[]): { ramMb: number; cpuPercent: number; processes: PerfSnapshot['processes'] } {
  const processes = metrics.map((m) => ({
    type: m.type,
    ramMb: Math.round((m.memory.workingSetSize / 1024) * 10) / 10,
    cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10,
  }));
  return {
    ramMb: Math.round(processes.reduce((a, p) => a + p.ramMb, 0) * 10) / 10,
    cpuPercent: Math.round(processes.reduce((a, p) => a + p.cpu, 0) * 10) / 10,
    processes,
  };
}

/** Detects sustained memory growth in a series of RAM samples (MB). Used by long-session tests and the dashboard. */
export function detectMemoryGrowth(samples: number[], thresholdMbPerSample = 0.5): { growing: boolean; slope: number } {
  if (samples.length < 5) return { growing: false, slope: 0 };
  const n = samples.length;
  const mx = (n - 1) / 2;
  const my = samples.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  samples.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
  const slope = den === 0 ? 0 : num / den;
  return { growing: slope > thresholdMbPerSample, slope: Math.round(slope * 1000) / 1000 };
}
