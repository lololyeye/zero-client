/**
 * Compatibility probe. Read-only: it checks which theming hooks exist in Discord's current DOM and whether
 * ZERO's stylesheet is present and actually winning the cascade. It never reads message content or storage.
 */
export const COMPAT_PROBE_SCRIPT = `(function(){
  var cs = getComputedStyle(document.documentElement);
  var vars = ['--background-base-low','--background-base-lower','--background-base-lowest','--text-default','--brand-500','--radius-sm'];
  var cls = function(n){ return ':is([class^="'+n+'_"],[class*=" '+n+'_"])'; };
  var selectors = [['appMount', cls('appMount')], ['sidebar', cls('sidebar')], ['channel list', cls('sidebarList')], ['server rail', 'nav'+cls('guilds')],
    ['user panel', cls('panels')], ['chat page', cls('page')], ['message input', cls('channelTextArea'), 'optional']];
  var style = document.getElementById('zero-theme');
  var zeroBg = cs.getPropertyValue('--zero-bg').trim();
  return {
    loggedInShell: !!document.querySelector(cls('sidebar')),
    style: { present: !!style && style.isConnected, count: document.querySelectorAll('style#zero-theme').length, bytes: style ? style.textContent.length : 0 },
    // does Discord's own variable resolve to ZERO's value? (proves the cascade is won, not just that CSS exists)
    winning: zeroBg ? cs.getPropertyValue('--background-base-lowest').trim().toLowerCase() === zeroBg.toLowerCase() : null,
    route: document.documentElement.dataset.zeroRoute || null,
    variables: vars.map(function(v){ return { name: v, present: cs.getPropertyValue(v).trim().length > 0 }; }),
    // optional parts only exist on some pages (no message input on the Friends page)
    selectors: selectors.map(function(s){ return { name: s[0], matches: document.querySelectorAll(s[1]).length, optional: s[2] === 'optional' }; })
  };
})()`;

export interface CompatReport {
  checkedAt: number;
  url: string;
  loggedInShell: boolean;
  style: { present: boolean; count: number; bytes: number } | null;
  winning: boolean | null;
  route: string | null;
  variables: { name: string; present: boolean }[];
  selectors: { name: string; matches: number; optional?: boolean }[];
  missingImages: string[];
  verdict: 'ok' | 'degraded' | 'unknown';
  summary: string;
}

export function evaluateCompat(raw: any, url: string, now = Date.now(), ctx: { expectStyle?: boolean; missingImages?: string[] } = {}): CompatReport {
  const base = { checkedAt: now, url: url.replace(/\/channels\/[\d@me/]+/, '/channels/…'), missingImages: ctx.missingImages ?? [] };
  if (!raw || typeof raw !== 'object') {
    return { ...base, loggedInShell: false, style: null, winning: null, route: null, variables: [], selectors: [], verdict: 'unknown', summary: 'Could not inspect the page (it may still be loading).' };
  }
  const common = { ...base, style: raw.style ?? null, winning: raw.winning ?? null, route: raw.route ?? null, variables: raw.variables ?? [], selectors: raw.selectors ?? [] };
  if (!raw.loggedInShell) {
    return { ...common, loggedInShell: false, verdict: 'unknown', summary: 'Discord main interface is not loaded yet (login screen or still loading). Check again after signing in.' };
  }
  const problems: string[] = [];
  const missingSel = (raw.selectors as any[]).filter((s) => s.matches === 0 && !s.optional).map((s) => s.name);
  const missingVars = (raw.variables as any[]).filter((v) => !v.present).map((v) => v.name);
  if (missingSel.length) problems.push(`interface parts not found: ${missingSel.join(', ')}`);
  if (missingVars.length) problems.push(`Discord variables not found: ${missingVars.join(', ')}`);
  if (ctx.expectStyle !== false) {
    if (!raw.style?.present) problems.push('ZERO stylesheet is not in the page');
    else if (raw.style.count > 1) problems.push(`${raw.style.count} ZERO stylesheets found (expected 1)`);
    if (raw.winning === false) problems.push("Discord's colors are overriding ZERO's");
  }
  if (base.missingImages.length) problems.push(`${base.missingImages.length} background image(s) missing on disk`);
  return {
    ...common, loggedInShell: true,
    verdict: problems.length ? 'degraded' : 'ok',
    summary: problems.length
      ? `${problems.join('; ')}. Affected customizations may not show; Discord itself is unaffected.`
      : 'All theming hooks were found and ZERO’s theme is applied and winning the cascade.',
  };
}
