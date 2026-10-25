/** Re-read mutable sidecars so a correction reaches an already open player. */
export function watchSubtitleText(options: {
  url: string;
  refresh: boolean;
  onText: (text: string) => void;
  onError: (error: unknown) => void;
}) {
  const controller = new AbortController();
  let loading = false;
  let previous: string | undefined;
  const load = async () => {
    if (loading || controller.signal.aborted) return;
    loading = true;
    try {
      const response = await fetch(options.url, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`Subtitle request failed with ${response.status}`);
      const text = await response.text();
      if (!controller.signal.aborted && text !== previous) {
        previous = text;
        options.onText(text);
      }
    } catch (error) {
      if (!controller.signal.aborted) options.onError(error);
    } finally {
      loading = false;
    }
  };
  const refresh = () => {
    if (!document.hidden) void load();
  };
  void load();
  const timer = options.refresh
    ? window.setInterval(refresh, 5_000)
    : undefined;
  if (options.refresh) document.addEventListener("visibilitychange", refresh);
  return () => {
    controller.abort();
    if (timer !== undefined) window.clearInterval(timer);
    document.removeEventListener("visibilitychange", refresh);
  };
}
