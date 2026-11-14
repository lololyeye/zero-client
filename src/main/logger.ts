import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Redact anything that looks like a credential before it can reach a log.
 * ZERO never reads Discord tokens; this is defence in depth for stack traces and URLs.
 */
export function redact(text: string): string {
  return text
    .replace(/\b[A-Za-z\d_-]{23,32}\.[\w-]{5,8}\.[\w-]{25,}\b/g, '[REDACTED_TOKEN]') // discord token shape
    .replace(/\bmfa\.[\w-]{20,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(?:Bearer|Basic|Bot)\s+[\w.~+/=-]{6,}/g, '[REDACTED]')
    .replace(/(authorization|token|cookie|password)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2[REDACTED]')
    .replace(/[?&](token|code|key|access_token)=[^&\s]+/gi, '?$1=[REDACTED]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, 'C:\\Users\\<user>');
}

export class Logger {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly file: string, private readonly maxBytes = 512 * 1024) {}

  log(level: 'info' | 'warn' | 'error', message: string, err?: unknown): void {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err !== undefined ? String(err) : '';
    const line = redact(`${new Date().toISOString()} [${level}] ${message}${detail ? ' :: ' + detail : ''}`) + '\n';
    this.queue = this.queue.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const st = await fs.stat(this.file).catch(() => null);
        if (st && st.size > this.maxBytes) await fs.rename(this.file, this.file + '.old').catch(() => undefined);
        await fs.appendFile(this.file, line, 'utf8');
      } catch { /* logging must never crash the app */ }
    });
  }
  info(m: string) { this.log('info', m); }
  warn(m: string, e?: unknown) { this.log('warn', m, e); }
  error(m: string, e?: unknown) { this.log('error', m, e); }
  flush() { return this.queue; }
}
