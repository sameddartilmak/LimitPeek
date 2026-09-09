/**
 * Theme application. One attribute on <html>, applied before first paint.
 *
 * WHY THIS IS NOT A RENDER PASS
 * -----------------------------
 * `initialPreferences()` is synchronous for the same reason `initialSnapshot()`
 * is: a theme applied after the first frame is a visible flash of the other
 * one. So the choice is read and written to the document during module
 * evaluation, before the panel is even built — not inside the store
 * subscription, which by definition runs after something has already been
 * rendered once.
 *
 * WHAT GOES ON THE ATTRIBUTE
 * --------------------------
 * The RESOLVED theme, always 'dark' or 'light' — never the word "system". CSS
 * cannot resolve "system" and a stylesheet that had to handle three values
 * would need `@media (prefers-color-scheme)` blocks duplicating every token,
 * which is the second surface that drifts. 'system' is resolved here, once,
 * and re-resolved whenever the OS setting changes.
 *
 * 'system' is a LIVE binding. The media query listener stays attached for the
 * lifetime of the app and is consulted on every change while 'system' is the
 * choice; it is not a one-time read at startup.
 */

import type { ThemeChoice } from '../../shared/contract.js';
// The one list of valid choices lives with the rest of the IPC input gate, so
// a fourth theme cannot be accepted here and rejected there.
import { isThemeChoice } from './sanitize.js';

export type ResolvedTheme = 'dark' | 'light';

/** The default when main has never told us anything. */
export const DEFAULT_THEME: ThemeChoice = 'system';

/** Turkish label for a choice. Sentence case; never uppercased (i -> I). */
export function themeLabel(choice: ThemeChoice): string {
  return choice === 'dark' ? 'Koyu' : choice === 'light' ? 'Açık' : 'Sistem';
}

export interface ThemeHandle {
  /** The choice currently applied. */
  choice(): ThemeChoice;
  /** What that choice resolves to right now. */
  resolved(): ResolvedTheme;
  /** Apply a choice to the document. Idempotent. */
  apply(choice: ThemeChoice): void;
  /** Called after every change, including OS-driven ones under 'system'. */
  onChange(listener: (choice: ThemeChoice, resolved: ResolvedTheme) => void): () => void;
  destroy(): void;
}

function query(): MediaQueryList | null {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    // A host without matchMedia cannot follow the OS; 'system' then means the
    // dark default, which is what tokens.css ships as its :root.
    return null;
  }
}

export function createTheme(initial: ThemeChoice = DEFAULT_THEME): ThemeHandle {
  const media = query();
  const listeners = new Set<(choice: ThemeChoice, resolved: ResolvedTheme) => void>();
  let choice: ThemeChoice = isThemeChoice(initial) ? initial : DEFAULT_THEME;
  let applied: ResolvedTheme | null = null;

  function resolve(next: ThemeChoice): ResolvedTheme {
    if (next === 'dark' || next === 'light') return next;
    // 'system' with no matchMedia falls back to dark, which is the palette
    // tokens.css declares on :root — so the document is never in a state the
    // stylesheet does not describe.
    return media === null || media.matches ? 'dark' : 'light';
  }

  function write(): void {
    const next = resolve(choice);
    if (next !== applied) {
      applied = next;
      document.documentElement.setAttribute('data-theme', next);
    }
    // Always mirrored, even when the resolved theme did not move: the settings
    // radio group reads this to tell "Koyu" from "Sistem, şu anda koyu".
    document.documentElement.setAttribute('data-theme-choice', choice);
  }

  function onMediaChange(): void {
    // Only 'system' follows the OS. A user who chose 'light' keeps light when
    // Windows flips at sunset — that is the whole point of an explicit choice.
    if (choice !== 'system') return;
    const before = applied;
    write();
    if (applied !== before) {
      for (const listener of listeners) listener(choice, applied as ResolvedTheme);
    }
  }

  if (media) {
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onMediaChange);
    } else if (typeof (media as unknown as { addListener?: unknown }).addListener === 'function') {
      // Older Chromium surface. Kept because it costs two lines and the
      // failure mode without it is silent: the theme simply stops following.
      (media as unknown as { addListener(cb: () => void): void }).addListener(onMediaChange);
    }
  }

  write();

  return {
    choice: () => choice,
    resolved: () => applied ?? resolve(choice),
    apply(next: ThemeChoice): void {
      if (!isThemeChoice(next) || next === choice) {
        // Still write: the first call has to land even when it matches the
        // default, or the attribute is missing for a frame.
        if (isThemeChoice(next)) write();
        return;
      }
      choice = next;
      const before = applied;
      write();
      if (applied !== before) {
        for (const listener of listeners) listener(choice, applied as ResolvedTheme);
      }
    },
    onChange(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy(): void {
      listeners.clear();
      if (media && typeof media.removeEventListener === 'function') {
        media.removeEventListener('change', onMediaChange);
      }
    },
  };
}
