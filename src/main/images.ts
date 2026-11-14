import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export const MAX_DIMENSION = 2560;

export type ImageKind = 'png' | 'jpg' | 'webp';

/** Detect by magic bytes, never by extension. */
export function sniffImage(buf: Uint8Array): ImageKind | null {
  if (buf.length >= 12) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  }
  return null;
}

export function targetSize(w: number, h: number, max = MAX_DIMENSION): { width: number; height: number } {
  const longest = Math.max(w, h);
  if (longest <= max) return { width: w, height: h };
  const f = max / longest;
  return { width: Math.round(w * f), height: Math.round(h * f) };
}

export interface ImageCodec {
  decode(buf: Buffer): { width: number; height: number; resize(w: number, h: number): unknown; toJPEG(q: number): Buffer; toPNG(): Buffer } | null;
}

/** Store directory for imported backgrounds. Large images are downscaled so they cost less GPU/RAM. */
export class ImageStore {
  constructor(private readonly dir: string, private readonly codec: ImageCodec) {}

  async import(file: string): Promise<{ id: string; width: number; height: number; bytes: number }> {
    const st = await fs.stat(file);
    if (st.size > MAX_SOURCE_BYTES) throw new Error('Image is larger than 40 MB.');
    const buf = await fs.readFile(file);
    const kind = sniffImage(buf);
    if (!kind) throw new Error('Unsupported image. Use PNG, JPG or WebP.');
    // Content-addressed id: importing the same file twice reuses the stored copy (no duplicate files/decodes).
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const existing = await this.resolve(id);
    if (existing) {
      const img = this.codec.decode(await fs.readFile(existing));
      if (img) return { id, width: img.width, height: img.height, bytes: (await fs.stat(existing)).size };
    }
    const img = this.codec.decode(buf);
    if (!img || !img.width || !img.height) throw new Error('The image is corrupted or could not be decoded.');
    const t = targetSize(img.width, img.height);
    const needsResize = t.width !== img.width;
    const work: any = needsResize ? img.resize(t.width, t.height) : img;
    await fs.mkdir(this.dir, { recursive: true });
    let out: Buffer, ext: string;
    if (kind === 'png') { out = work.toPNG(); ext = 'png'; }
    else { out = work.toJPEG(88); ext = 'jpg'; }
    if (!needsResize && out.length > buf.length && kind !== 'png') { out = buf; ext = kind === 'webp' ? 'webp' : 'jpg'; }
    await fs.writeFile(path.join(this.dir, `${id}.${ext}`), out);
    return { id, width: t.width, height: t.height, bytes: out.length };
  }

  async resolve(id: string): Promise<string | null> {
    if (!/^[a-z0-9_-]{1,64}$/i.test(id)) return null;
    for (const ext of ['jpg', 'png', 'webp']) {
      const p = path.join(this.dir, `${id}.${ext}`);
      try { await fs.access(p); return p; } catch { /* next */ }
    }
    return null;
  }

  /** Previously imported images (newest first), so an image can be reused without importing it again. */
  async list(): Promise<{ id: string; bytes: number; modified: number }[]> {
    let names: string[] = [];
    try { names = await fs.readdir(this.dir); } catch { return []; }
    const out: { id: string; bytes: number; modified: number }[] = [];
    for (const n of names) {
      const m = n.match(/^([a-z0-9_-]{1,64})\.(jpg|png|webp)$/i);
      if (!m) continue;
      const st = await fs.stat(path.join(this.dir, n)).catch(() => null);
      if (st) out.push({ id: m[1]!, bytes: st.size, modified: st.mtimeMs });
    }
    return out.sort((a, b) => b.modified - a.modified);
  }

  async remove(id: string): Promise<void> {
    const p = await this.resolve(id);
    if (p) await fs.unlink(p).catch(() => undefined);
  }
}
