import { BUILTINS } from '../shared/builtins';

/**
 * InlineTranslator: one message's text (that the user picked, at most 500 characters) goes to the MyMemory
 * translation API; nothing else is sent (no names, no ids, no cookies: plain fetch, outside Discord's session).
 */
const ENDPOINT = 'https://api.mymemory.translated.net/get';
const def = BUILTINS.find((b) => b.id === 'inlineTranslator')!.settings.find((s) => s.key === 'to');
export const TRANSLATE_LANGS = new Set(def && def.type === 'select' ? def.options.map((o) => o.value) : []);

export type Translation = { text: string; from: string } | { error: string };

export function translationUrl(text: string, to: string): string {
  return `${ENDPOINT}?q=${encodeURIComponent(text.slice(0, 500))}&langpair=autodetect|${encodeURIComponent(to)}`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

const base = (lang: string) => lang.toLowerCase().split('-')[0];

export function parseTranslation(raw: unknown, to: string): Translation {
  const r = raw as any;
  const details = String(r?.responseDetails ?? '');
  const text = r?.responseData?.translatedText;
  if (Number(r?.responseStatus) !== 200 || typeof text !== 'string' || !text.trim()) {
    if (/distinct languages/i.test(details)) return { error: 'This message is already in that language.' };
    if (r?.quotaFinished === true || /quota|limit/i.test(details)) return { error: 'The free translation quota for today is used up.' };
    return { error: 'The translation service could not translate this message.' };
  }
  const from = typeof r?.responseData?.detectedLanguage === 'string' ? r.responseData.detectedLanguage.slice(0, 10) : '';
  if (from && base(from) === base(to)) return { error: 'This message is already in that language.' };
  return { text: decodeEntities(text).slice(0, 2000), from };
}

/** At most 10 translations a minute; every answer is parsed, never passed through as-is. */
export function createTranslator(fetchFn: (url: string, init: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)) {
  const recent: number[] = [];
  return async (text: unknown, to: unknown): Promise<Translation> => {
    if (typeof text !== 'string' || !text.trim() || typeof to !== 'string' || !TRANSLATE_LANGS.has(to)) return { error: 'Nothing to translate.' };
    const now = Date.now();
    while (recent.length && now - recent[0]! > 60_000) recent.shift();
    if (recent.length >= 10) return { error: 'Too many translations in a minute. Try again in a moment.' };
    recent.push(now);
    try {
      const res = await fetchFn(translationUrl(text, to), { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
      if (!res.ok) return { error: 'The translation service is busy. Try again later.' };
      return parseTranslation(await res.json(), to);
    } catch {
      return { error: 'The translation service is not reachable.' };
    }
  };
}
