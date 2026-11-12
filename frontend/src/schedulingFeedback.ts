const MINIMUM_REVEAL_MS = 1000;

export async function prepareScheduleResult(startedAt: number, signal: AbortSignal, onPreparing: () => void) {
  if (signal.aborted) return false;
  const remaining = MINIMUM_REVEAL_MS - (performance.now() - startedAt);
  if (remaining > 0) {
    onPreparing();
    await new Promise<void>((resolve) => {
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      }

      const timer = setTimeout(finish, remaining);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  return !signal.aborted;
}
