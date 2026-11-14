/**
 * Renderer-side theme controller for the Discord page.
 *
 * - Owns exactly ONE <style id="zero-theme"> element; updates replace its text (no duplicates, no leaks).
 * - Position in <head> does not matter: every ZERO declaration is !important with enough specificity, so it wins
 *   regardless of the hundreds of stylesheets Discord appends lazily. (Moving the element to stay "last" would force
 *   a full style recalculation on every such append, so we deliberately don't.)
 * - A MutationObserver on the direct children of <head> only (never the app subtree) re-attaches the element if
 *   something removes it.
 * - Tracks the route kind as html[data-zero-route] (DM background) and the focus state as html.zero-paused.
 */
export interface ApplyPayload {
  css: string;
  pauseWhenUnfocused: boolean;
}

export const STYLE_ID = 'zero-theme';

export interface ThemeController {
  apply(p: ApplyPayload): void;
  setRoute(route: string): void;
  setFocused(focused: boolean): void;
  /** for diagnostics/tests */
  state(): { css: string; styles: number; attached: boolean; route: string | null; paused: boolean; textWrites: number };
  dispose(): void;
}

export function createThemeController(doc: Document, MO: typeof MutationObserver = MutationObserver): ThemeController {
  let css = '';
  let pauseWhenUnfocused = false;
  let focused = true;
  let route: string | null = null;
  let el: HTMLStyleElement | null = null;
  let observed: Node | null = null;
  let textWrites = 0;

  const observer = new MO(() => { if (css && el && !el.isConnected) attach(); });

  function attach() {
    const parent = doc.head ?? doc.documentElement;
    if (!parent || !el) return;
    if (!el.isConnected) parent.appendChild(el);
    // watch the element's current parent (head once it exists), children only
    const p = el.parentNode;
    if (p && p !== observed) { observer.disconnect(); observer.observe(p, { childList: true }); observed = p; }
  }

  function render() {
    const root = doc.documentElement;
    if (!root) return; // document not created yet; DOMContentLoaded will call render again
    if (route !== null && root.dataset.zeroRoute !== route) root.dataset.zeroRoute = route;
    root.classList.toggle('zero-paused', pauseWhenUnfocused && !focused);
    if (!css) { el?.remove(); return; }
    if (!el) {
      // A previous controller instance may have left one behind; adopt it instead of creating a duplicate.
      const existing = doc.querySelectorAll<HTMLStyleElement>(`style#${STYLE_ID}`);
      el = existing[0] ?? doc.createElement('style');
      for (let i = 1; i < existing.length; i++) existing[i]!.remove();
      el.id = STYLE_ID;
    }
    if (el.textContent !== css) { el.textContent = css; textWrites++; }
    attach();
  }

  if (!doc.documentElement || !doc.head) doc.addEventListener('DOMContentLoaded', render, { once: true });

  return {
    apply(p) { css = p.css; pauseWhenUnfocused = p.pauseWhenUnfocused; render(); },
    setRoute(r) { route = r; render(); },
    setFocused(f) { if (f !== focused) { focused = f; render(); } },
    state() {
      const root = doc.documentElement;
      return {
        css, styles: doc.querySelectorAll(`style#${STYLE_ID}`).length, attached: !!el?.isConnected,
        route: root?.dataset.zeroRoute ?? null, paused: root?.classList.contains('zero-paused') ?? false, textWrites,
      };
    },
    dispose() { observer.disconnect(); el?.remove(); el = null; doc.documentElement?.classList.remove('zero-paused'); },
  };
}

/** Classify a Discord URL path for area backgrounds. */
export function routeKind(pathname: string): 'dm' | 'guild' | 'other' {
  if (/^\/channels\/@me(\/|$)/.test(pathname)) return 'dm';
  if (/^\/channels\/\d+/.test(pathname)) return 'guild';
  return 'other';
}
