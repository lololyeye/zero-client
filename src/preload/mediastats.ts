/**
 * Voice / stream diagnostics, page world. Discord's WebRTC connections are remembered (weakly) when they are
 * created; nothing else happens until the Performance page asks for numbers, which only happens while that page
 * is open. Only media statistics leave this function: codec, encoder/decoder, resolution, frame rate, bitrate,
 * packet loss, audio concealment. Never addresses (ICE candidates), SDP, identities or message content.
 *
 * Like the plugin runtime it is serialized: it must not reference anything outside its own body.
 */
export function zeroMediaStats(): void {
  const W = window as any;
  const Orig = W.RTCPeerConnection;
  if (typeof Orig !== 'function' || W.__zeroMediaStats) return;
  W.__zeroMediaStats = true;
  const pcs = new Set<WeakRef<RTCPeerConnection>>();
  try {
    W.RTCPeerConnection = new Proxy(Orig, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget);
        try { pcs.add(new WeakRef(pc)); } catch { /* ignore */ }
        return pc;
      },
    });
  } catch { return; }

  const prev = new Map<string, { bytes: number; at: number }>();
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : null);

  async function collect(): Promise<unknown[]> {
    const out: unknown[] = [];
    let i = 0;
    for (const ref of pcs) {
      const pc = ref.deref();
      if (!pc || pc.connectionState === 'closed') { pcs.delete(ref); continue; }
      const n = i++;
      let report: RTCStatsReport;
      try { report = await pc.getStats(); } catch { continue; }
      const codecs = new Map<string, string>();
      report.forEach((r: any) => { if (r.type === 'codec') codecs.set(r.id, String(r.mimeType ?? '').replace(/^(audio|video)\//, '')); });
      report.forEach((r: any) => {
        if (r.type !== 'outbound-rtp' && r.type !== 'inbound-rtp') return;
        const send = r.type === 'outbound-rtp';
        const bytes = num(send ? r.bytesSent : r.bytesReceived) ?? 0;
        const key = `${n}:${r.id}`; const now = performance.now(); const p = prev.get(key);
        prev.set(key, { bytes, at: now });
        const kbps = p && now > p.at ? Math.round(((bytes - p.bytes) * 8) / (now - p.at)) : null;
        const base = { dir: send ? 'send' : 'recv', kind: r.kind === 'video' ? 'video' : 'audio', codec: codecs.get(r.codecId) ?? null, kbps };
        if (r.kind === 'video') {
          out.push({
            ...base, width: num(r.frameWidth), height: num(r.frameHeight), fps: num(r.framesPerSecond),
            impl: str(send ? r.encoderImplementation : r.decoderImplementation),
            hw: typeof (send ? r.powerEfficientEncoder : r.powerEfficientDecoder) === 'boolean' ? (send ? r.powerEfficientEncoder : r.powerEfficientDecoder) : null,
            limit: send ? str(r.qualityLimitationReason) : null,
            dropped: send ? null : num(r.framesDropped), freezes: send ? null : num(r.freezeCount),
          });
        } else if (!send) {
          const total = num(r.totalSamplesReceived) ?? 0;
          out.push({ ...base, concealedPct: total > 0 ? Math.round(((num(r.concealedSamples) ?? 0) / total) * 10000) / 100 : null, jitterMs: r.jitter != null ? Math.round(r.jitter * 1000) : null, lost: num(r.packetsLost) });
        } else out.push(base);
      });
    }
    return out;
  }

  document.addEventListener('zero:rtc-req', () => {
    collect().then(
      (streams) => document.dispatchEvent(new CustomEvent('zero:rtc', { detail: JSON.stringify({ connections: pcs.size, streams }) })),
      () => document.dispatchEvent(new CustomEvent('zero:rtc', { detail: '{"connections":0,"streams":[]}' })),
    );
  });
}
