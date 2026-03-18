/**
 * Polls a function every intervalMs, pausing when the tab is hidden.
 * Returns a cleanup function to stop polling.
 */
export function startPolling(
  fn: () => Promise<void>,
  intervalMs: number = 3000
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (!stopped && !document.hidden) {
        await fn().catch(() => {});
      }
      schedule();
    }, intervalMs);
  };

  const onVisibilityChange = () => {
    if (!document.hidden && !stopped) {
      fn().catch(() => {});
    }
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
