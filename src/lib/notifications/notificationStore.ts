import type { TaskDetail } from "./taskNotifications";
import { randomUuid } from "../randomId";

/**
 * Transient feedback, held outside React.
 *
 * A module that is not a component — an API wrapper, a background poller —
 * still needs to say what happened, so the store is a plain subscribable object
 * rather than a context. Components read it through `useSyncExternalStore`.
 */

export type NotificationTone =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "progress";

/**
 * How long a notification stays.
 *
 * `short` is for something the viewer already knows they did; `long` is for
 * something they may have looked away from; `persistent` is for anything they
 * would be worse off missing, and only a click dismisses it.
 */
export type NotificationLife = "short" | "long" | "persistent";

export const NOTIFICATION_LIFETIMES_MS: Record<
  Exclude<NotificationLife, "persistent">,
  number
> = {
  short: 4_000,
  long: 9_000,
};

export interface SeyirlikNotification {
  id: string;
  tone: NotificationTone;
  title: string;
  description?: string;
  /** 0–100 while work is in flight; absent when there is nothing to measure. */
  progress?: number;
  task?: TaskDetail;
  life: NotificationLife;
  createdAt: number;
  firstShownAt?: number;
  updatedAt?: number;
}

export interface NotifyInput {
  tone?: NotificationTone;
  title: string;
  description?: string;
  progress?: number;
  task?: TaskDetail;
  life?: NotificationLife;
  /**
   * Replaces any earlier notification with the same key instead of stacking a
   * second one. A scan reporting every few per cent must not leave a column of
   * near-identical cards behind it.
   */
  key?: string;
  /** Update a retained history entry without raising another toast. */
  historyOnly?: boolean;
}

type Listener = () => void;

let notifications: SeyirlikNotification[] = [];
let history: SeyirlikNotification[] = [];
const MAX_HISTORY = 100;
const keyed = new Map<string, string>();
const listeners = new Set<Listener>();

/** Beyond this the oldest are dropped; nobody reads a hundred of them. */
const MAX_NOTIFICATIONS = 12;

/*
 * Lifetimes run here, not in whatever draws them. Nothing is on screen until
 * someone opens the notification centre, so a short notice must still expire
 * on its own, and its clock holds while the centre is open and being read.
 */
interface Clock {
  createdAt: number;
  remaining: number;
  startedAt: number;
  timer: number | undefined;
}
const clocks = new Map<string, Clock>();
let clocksHeld = false;

function stopClock(clock: Clock): void {
  if (clock.timer === undefined) return;
  window.clearTimeout(clock.timer);
  clock.timer = undefined;
  clock.remaining = Math.max(
    0,
    clock.remaining - (Date.now() - clock.startedAt),
  );
}

function startClock(id: string, clock: Clock): void {
  if (clock.timer !== undefined || clocksHeld) return;
  clock.startedAt = Date.now();
  clock.timer = window.setTimeout(() => {
    clocks.delete(id);
    dismissNotification(id);
  }, clock.remaining);
}

function syncClocks(): void {
  if (typeof window === "undefined") return;
  const live = new Set<string>();
  for (const entry of notifications) {
    if (entry.life === "persistent") continue;
    live.add(entry.id);
    let clock = clocks.get(entry.id);
    if (!clock || clock.createdAt !== entry.createdAt) {
      if (clock) stopClock(clock);
      clock = {
        createdAt: entry.createdAt,
        remaining: Math.max(
          0,
          NOTIFICATION_LIFETIMES_MS[entry.life] -
            (Date.now() - entry.createdAt),
        ),
        startedAt: Date.now(),
        timer: undefined,
      };
      clocks.set(entry.id, clock);
    }
    startClock(entry.id, clock);
  }
  for (const [id, clock] of clocks) {
    if (live.has(id)) continue;
    stopClock(clock);
    clocks.delete(id);
  }
}

/** Holds every notice's clock while the centre is open, and lets them go. */
export function holdNotificationClocks(hold: boolean): void {
  if (clocksHeld === hold) return;
  clocksHeld = hold;
  for (const [id, clock] of clocks) {
    if (hold) stopClock(clock);
    else startClock(id, clock);
  }
}

/*
 * What has been looked at. A notice is new until the centre is opened after
 * it arrived or last changed; the bell shows that there is something new
 * without putting the notice itself on screen.
 */
let seenAt = 0;

export function getNotificationsSeenAt(): number {
  return seenAt;
}

export function markNotificationsSeen(): void {
  seenAt = Date.now();
  emit();
}

/**
 * New since the centre was last opened: it arrived since, or it came to an
 * outcome since. A running job's progress ticks are not news.
 */
export function isNotificationUnseen(
  entry: SeyirlikNotification,
  since: number = seenAt,
): boolean {
  if ((entry.firstShownAt ?? entry.createdAt) > since) return true;
  return entry.tone !== "progress" && entry.tone !== "info"
    ? (entry.updatedAt ?? entry.createdAt) > since
    : false;
}

function emit(): void {
  syncClocks();
  for (const listener of listeners) listener();
}

export function subscribeToNotifications(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Newest first, which is the order they are shown in. */
export function getNotifications(): SeyirlikNotification[] {
  return notifications;
}

export function getNotificationHistory(): SeyirlikNotification[] {
  return history;
}

export function clearNotificationHistory(): void {
  history = [];
  keyed.clear();
  emit();
}

function retain(entry: SeyirlikNotification): void {
  history = [entry, ...history.filter((item) => item.id !== entry.id)].slice(
    0,
    MAX_HISTORY,
  );
  for (const [key, id] of keyed) {
    if (
      !history.some((item) => item.id === id) &&
      !notifications.some((item) => item.id === id)
    )
      keyed.delete(key);
  }
}

function defaultLife(tone: NotificationTone): NotificationLife {
  // Progress has no natural end until the work does, and an error is the one
  // thing a viewer should never miss because they blinked.
  if (tone === "progress" || tone === "error") return "persistent";
  return tone === "warning" ? "long" : "short";
}

export function notify(input: NotifyInput): string {
  const tone = input.tone ?? "info";
  const key =
    input.key ?? `message:${tone}:${input.title}:${input.description ?? ""}`;
  const existingId = keyed.get(key);
  const existing = history.find((entry) => entry.id === existingId);

  if (existingId && existing) {
    if (
      !input.historyOnly &&
      !notifications.some((entry) => entry.id === existingId)
    )
      notifications = [existing, ...notifications].slice(0, MAX_NOTIFICATIONS);
    const sameAttempt =
      input.task &&
      existing.task?.attempts === input.task.attempts &&
      existing.task.status === input.task.status;
    const progress =
      sameAttempt &&
      input.task?.status === "running" &&
      input.progress !== undefined &&
      existing.progress !== undefined
        ? Math.max(existing.progress, input.progress)
        : input.progress;
    updateNotification(existingId, {
      updatedAt: Date.now(),
      tone,
      title: input.title,
      // Cleared rather than kept: replacing a card is saying something new, and
      // an old description under a new title would be a lie.
      description: input.description,
      progress,
      task: input.task,
      life: input.life ?? defaultLife(tone),
      // A task outcome starts its lifetime once. Routine updates within the
      // same state/attempt keep that deadline; generic replacements restart.
      createdAt: sameAttempt ? existing.createdAt : Date.now(),
    });
    return existingId;
  }

  const notification: SeyirlikNotification = {
    id: randomUuid(),
    tone,
    title: input.title,
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    task: input.task,
    life: input.life ?? defaultLife(tone),
    createdAt: Date.now(),
    firstShownAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (!input.historyOnly)
    notifications = [notification, ...notifications].slice(
      0,
      MAX_NOTIFICATIONS,
    );
  retain(notification);
  keyed.set(key, notification.id);
  emit();
  return notification.id;
}

export function updateNotification(
  id: string,
  patch: Partial<Omit<SeyirlikNotification, "id">>,
): void {
  let changed = false;
  notifications = notifications.map((entry) => {
    if (entry.id !== id) return entry;
    changed = true;
    return { ...entry, ...patch };
  });
  const previous = history.find((entry) => entry.id === id);
  if (previous) {
    retain({ ...previous, ...patch });
    changed = true;
  }
  if (changed) emit();
}

export function dismissNotification(id: string): void {
  const before = notifications.length;
  notifications = notifications.filter((entry) => entry.id !== id);
  if (notifications.length !== before) emit();
}

export function dismissAllNotifications(): void {
  if (notifications.length === 0) return;
  notifications = [];
  emit();
}

/** Test seam; production code never needs to reset the store. */
export function resetNotificationsForTests(): void {
  notifications = [];
  history = [];
  keyed.clear();
  listeners.clear();
  for (const clock of clocks.values()) stopClock(clock);
  clocks.clear();
  clocksHeld = false;
  seenAt = 0;
}
