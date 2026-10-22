/**
 * How long a hero title has left, kept as time rather than as a value stepped
 * every frame.
 *
 * The bar that shows it is one Web Animation per run: the compositor plays it
 * at the display's full rate whatever the page is doing, and nothing on the
 * main thread touches it until the run stops. The end of the dwell is a timer.
 * A requestAnimationFrame loop used to write the bar's scale every frame, which
 * Safari holds to 60 fps and which stalls with the main thread.
 */
export class DwellClock {
  private bar: HTMLElement | null = null;
  /** The fraction reached, while no run is going. */
  private done = 0;
  private run: {
    from: number;
    started: number;
    onDone: () => void;
    animation: Animation | null;
    timer: number;
  } | null = null;
  private marks = new Set<{ at: number; fire: () => void; timer: number }>();

  constructor(private readonly durationMs: number) {}

  /** A callback ref for the bar (a left-anchored element scaled along x). */
  readonly attach = (element: HTMLElement | null) => {
    if (this.bar === element) return;
    this.run?.animation?.cancel();
    this.bar = element;
    this.paint(this.fraction);
    if (this.run) this.run.animation = this.animateBar(this.fraction);
  };

  get fraction(): number {
    if (!this.run) return this.done;
    const elapsed = performance.now() - this.run.started;
    return Math.min(1, this.run.from + elapsed / this.durationMs);
  }

  get isRunning(): boolean {
    return this.run !== null;
  }

  /**
   * Runs from where the clock stands to the end, then calls `onDone`. Returns
   * the stop, which keeps the place reached.
   */
  start(onDone: () => void): () => void {
    this.stop();
    const from = this.done;
    const remaining = (1 - from) * this.durationMs;
    this.paint(from);
    const run = {
      from,
      started: performance.now(),
      onDone,
      animation: this.animateBar(from),
      timer: window.setTimeout(() => {
        if (this.run !== run) return;
        this.stop();
        onDone();
      }, remaining),
    };
    this.run = run;
    this.armMarks();
    return () => {
      if (this.run === run) this.stop();
    };
  }

  /** Holds the clock at the place reached. */
  stop(): void {
    const run = this.run;
    if (!run) return;
    this.done = this.fraction;
    this.run = null;
    window.clearTimeout(run.timer);
    run.animation?.cancel();
    this.disarmMarks();
    this.paint(this.done);
  }

  /** Back to the start; a running clock carries on from there. */
  reset(): void {
    const onDone = this.run?.onDone;
    this.stop();
    this.done = 0;
    this.paint(0);
    if (onDone) this.start(onDone);
  }

  /**
   * Calls `fire` once the running clock reaches `at` (a fraction): at once
   * when it starts beyond it, never while it is held.
   */
  onReach(at: number, fire: () => void): () => void {
    const mark = { at, fire, timer: 0 };
    this.marks.add(mark);
    if (this.run) this.armMark(mark);
    return () => {
      window.clearTimeout(mark.timer);
      this.marks.delete(mark);
    };
  }

  private armMarks() {
    for (const mark of this.marks) this.armMark(mark);
  }

  private armMark(mark: { at: number; fire: () => void; timer: number }) {
    window.clearTimeout(mark.timer);
    const wait = Math.max(0, (mark.at - this.fraction) * this.durationMs);
    mark.timer = window.setTimeout(() => {
      if (this.run) mark.fire();
    }, wait);
  }

  private disarmMarks() {
    for (const mark of this.marks) window.clearTimeout(mark.timer);
  }

  private animateBar(from: number): Animation | null {
    const bar = this.bar;
    if (!bar || typeof bar.animate !== "function") return null;
    return bar.animate(
      [{ transform: `scaleX(${from})` }, { transform: "scaleX(1)" }],
      {
        duration: (1 - from) * this.durationMs,
        easing: "linear",
        fill: "forwards",
      },
    );
  }

  private paint(fraction: number) {
    if (this.bar) this.bar.style.transform = `scaleX(${fraction})`;
  }
}
