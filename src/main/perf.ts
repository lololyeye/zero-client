import type { PerfProfile } from '../shared/config';

export interface ProcMetric {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  cpu: { percentCPUUsage: number };
  /** KB. privateBytes is Windows-only; workingSetSize includes memory shared between processes. */
  memory: { workingSetSize: number; privateBytes?: number };
}

/** One live voice/stream track, as reported by the Discord page (see preload/mediastats.ts). */
export interface MediaStream {
  dir: 'send' | 'recv';
  kind: 'audio' | 'video';
  codec: string | null;
  kbps: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  impl?: string | null;
  hw?: boolean | null;
  limit?: string | null;
  dropped?: number | null;
  freezes?: number | null;
  concealedPct?: number | null;
  jitterMs?: number | null;
  lost?: number | null;
}

export interface Recommendation { level: 'info' | 'warn'; text: string }

export interface PerfSnapshot {
  /** private memory (what Task Manager shows), MB */
  ramMb: number;
  cpuPercent: number;
  processes: { type: string; ramMb: number; cpu: number }[];
  gpu: string;
  gpuFeatures: Record<string, string>;
  hardwareAcceleration: boolean;
  startupMs: number | null;
  profile: PerfProfile;
  /** main process event-loop delay while the page is open (ms) */
  eventLoop: { p50: number; p99: number; max: number } | null;
  /** one point per minute since start (MB) */
  session: { minutes: number; ramMb: number[]; growthMbPerHour: number | null };
  media: { connections: number; streams: MediaStream[] } | null;
  recommendations: Recommendation[];
  activeModules: string[];
  background: string[];
  at: number;
}

const kbToMb = (kb: number) => Math.round((kb / 1024) * 10) / 10;

/** Aggregate Electron app metrics (KB). Private memory when the platform reports it, else working set. */
export function summarizeMetrics(metrics: ProcMetric[]): { ramMb: number; cpuPercent: number; processes: PerfSnapshot['processes'] } {
  const processes = metrics.map((m) => ({
    type: m.type === 'Utility' && (m.name || m.serviceName) ? String(m.name || m.serviceName) : m.type,
    ramMb: kbToMb(m.memory.privateBytes ?? m.memory.workingSetSize),
    cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10,
  }));
  return {
    ramMb: Math.round(processes.reduce((a, p) => a + p.ramMb, 0) * 10) / 10,
    cpuPercent: Math.round(processes.reduce((a, p) => a + p.cpu, 0) * 10) / 10,
    processes,
  };
}

/** Least-squares slope of evenly spaced samples (units per sample). */
function slope(samples: number[]): number {
  const n = samples.length;
  const mx = (n - 1) / 2;
  const my = samples.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  samples.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
  return den === 0 ? 0 : num / den;
}

/** Detects sustained memory growth in a series of RAM samples (MB). Used by long-session tests and the dashboard. */
export function detectMemoryGrowth(samples: number[], thresholdMbPerSample = 0.5): { growing: boolean; slope: number } {
  if (samples.length < 5) return { growing: false, slope: 0 };
  const s = slope(samples);
  return { growing: s > thresholdMbPerSample, slope: Math.round(s * 1000) / 1000 };
}

/**
 * Growth per hour over the last `window` one-minute samples, ignoring the first 10 minutes (Discord fills its
 * caches after start; that is not a leak). Null until there are 30 usable minutes.
 */
export function sessionGrowth(perMinute: number[], window = 180): number | null {
  const usable = perMinute.slice(10).slice(-window);
  if (usable.length < 30) return null;
  return Math.round(slope(usable) * 60 * 10) / 10;
}

/** Timer lateness samples (ms) → typical / worst 1% / worst. Null with fewer than 4 samples. */
export function stallStats(lateMs: number[]): PerfSnapshot['eventLoop'] {
  if (lateMs.length < 4) return null;
  const s = [...lateMs].sort((a, b) => a - b);
  const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10;
  return { p50: q(0.5), p99: q(0.99), max: Math.round(s[s.length - 1]! * 10) / 10 };
}

/** Plain-language advice from measured values only. */
export function recommendations(s: Pick<PerfSnapshot, 'hardwareAcceleration' | 'gpuFeatures' | 'session' | 'media' | 'eventLoop' | 'profile' | 'ramMb'>): Recommendation[] {
  const out: Recommendation[] = [];
  if (!s.hardwareAcceleration) {
    out.push({ level: 'warn', text: 'Hardware acceleration is off (Settings > General). Screen sharing then encodes on the CPU and scrolling is heavier. Turn it back on unless your graphics driver crashes.' });
  } else if (s.gpuFeatures.video_encode && !s.gpuFeatures.video_encode.startsWith('enabled')) {
    out.push({ level: 'warn', text: 'Chromium reports hardware video encoding as unavailable: streams will encode on the CPU. Updating the graphics driver usually fixes this.' });
  }
  const g = s.session.growthMbPerHour;
  if (g !== null && g > 60) out.push({ level: 'warn', text: `Memory has been rising by about ${Math.round(g)} MB per hour. If it keeps going, restart ZERO and report it with the numbers above.` });
  for (const m of s.media?.streams ?? []) {
    if (m.kind === 'video' && m.dir === 'send') {
      if (m.hw === false) out.push({ level: 'warn', text: `Your stream is encoded on the CPU (${m.codec ?? 'video'}${m.impl ? ', ' + m.impl : ''}). On a busy PC this costs game frames.` });
      if (m.limit === 'cpu') out.push({ level: 'warn', text: 'Your stream quality is being reduced because the CPU is busy. Lower the stream frame rate or resolution, or use the Low Resource profile.' });
      if (m.limit === 'bandwidth') out.push({ level: 'info', text: 'Your stream quality is limited by your upload speed, not by your PC.' });
    }
    if (m.kind === 'audio' && m.dir === 'recv' && (m.concealedPct ?? 0) > 2) out.push({ level: 'warn', text: `${m.concealedPct}% of received voice audio had to be concealed (dropouts). This comes from the network or a busy CPU, not from ZERO's theme.` });
    if (m.kind === 'video' && m.dir === 'recv' && (m.freezes ?? 0) > 5) out.push({ level: 'info', text: 'A stream you are watching froze several times: usually the streamer’s upload or your download.' });
  }
  if (s.eventLoop && s.eventLoop.p99 > 100) out.push({ level: 'warn', text: `ZERO's main process stalled up to ${Math.round(s.eventLoop.p99)} ms. Please report this.` });
  if (s.profile === 'balanced' && s.ramMb > 1500) out.push({ level: 'info', text: 'Memory use is high for this PC. The Low Resource profile turns off background images and other extras without restarting.' });
  return out;
}
