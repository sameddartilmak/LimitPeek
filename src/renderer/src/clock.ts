/**
 * One 1Hz ticker for the whole panel.
 *
 * Reset countdowns and freshness are derived locally from `resetsAt` and
 * `generatedAt`. The renderer never waits for a push to move a clock, and it
 * never runs more than one interval, so an idle panel costs one timer.
 */

type Tick = (nowMs: number) => void;

const listeners = new Set<Tick>();
let timer: number | null = null;

function fire(): void {
  const now = Date.now();
  for (const listener of listeners) {
    try {
      listener(now);
    } catch {
      // A broken subscriber must not stop the clock for the others.
    }
  }
}

function schedule(): void {
  if (timer !== null) return;
  // Align to the next whole second so every countdown flips together.
  const delay = 1000 - (Date.now() % 1000);
  timer = window.setTimeout(() => {
    timer = null;
    if (listeners.size === 0) return;
    fire();
    schedule();
  }, delay);
}

function stop(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

export function everySecond(listener: Tick): () => void {
  listeners.add(listener);
  schedule();
  listener(Date.now());
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/**
 * A hidden panel does not need to tick; resync immediately when it returns.
 * Returns its own unbind so destroy() is a complete teardown — an app-lifetime
 * listener is still a leak the moment anything mounts twice, which the dev
 * harness does on every scenario switch.
 */
export function bindVisibility(): () => void {
  const onVisibilityChange = (): void => {
    if (document.hidden) {
      stop();
    } else {
      fire();
      schedule();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => document.removeEventListener('visibilitychange', onVisibilityChange);
}
