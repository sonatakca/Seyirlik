import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { move, REST, settle } from "../../lib/compositorMotion";
import { AlertCircle, Loader2, Play } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { describeWaiting } from "./partyNotices";
import type { PartyPlayback } from "./usePartyPlayback";
import type { PartyWatch } from "./usePartyWatch";

/**
 * The one line the player shows about the party, only when there is something
 * worth knowing: it is recovering, waiting for someone, or needs the viewer.
 * In sync, it is not there at all.
 */

interface PartyWatchStatusProps {
  party: PartyWatch;
  playback: PartyPlayback;
}

/** A failed command is reported for this long; the undo itself is instant. */
const FAILURE_VISIBLE_MS = 4_000;

type Line =
  | { kind: "progress"; key: string; text: string }
  | { kind: "action"; key: string; text: string; onClick: () => void }
  | { kind: "problem"; key: string; text: string };

export function PartyWatchStatus({ party, playback }: PartyWatchStatusProps) {
  const { t } = useLanguage();
  const reduceMotion = useReducedMotion();
  const state = party.state;
  const [showFailure, setShowFailure] = useState(false);
  const commandFailed = state?.commandFailed ?? false;

  useEffect(() => {
    if (!commandFailed) {
      setShowFailure(false);
      return undefined;
    }
    setShowFailure(true);
    const timer = setTimeout(() => setShowFailure(false), FAILURE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [commandFailed]);

  let line: Line | null = null;
  if (state && state.connection !== "ended") {
    const waiting = state.snapshot
      ? describeWaiting(state.snapshot, state.selfId, t)
      : null;

    if (state.connection === "joining") {
      line = {
        kind: "progress",
        key: "joining",
        text: t("party.status.joining"),
      };
    } else if (state.connection === "reconnecting") {
      line = {
        kind: "progress",
        key: "reconnecting",
        text: t("party.status.reconnecting"),
      };
    } else if (playback.localState === "blocked") {
      line = {
        kind: "action",
        key: "blocked",
        text: t("party.status.blocked"),
        onClick: playback.resumeWithParty,
      };
    } else if (playback.localState === "paused-locally") {
      line = {
        kind: "action",
        key: "paused-locally",
        text: t("party.status.pausedLocally"),
        onClick: playback.resumeWithParty,
      };
    } else if (showFailure) {
      line = {
        kind: "problem",
        key: "failed",
        text: t("party.status.commandFailed"),
      };
    } else if (waiting) {
      line = { kind: "progress", key: `waiting:${waiting}`, text: waiting };
    } else if (playback.localState === "catching-up") {
      line = {
        kind: "progress",
        key: "catching-up",
        text: t("party.status.catchingUp"),
      };
    }
  }

  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const };

  return (
    <div
      className="pointer-events-none absolute left-1/2 top-[max(5.25rem,calc(env(safe-area-inset-top)+4.75rem))] z-40 flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 justify-center"
      aria-live="polite"
    >
      <AnimatePresence mode="wait" initial={false}>
        {line ? (
          <motion.div
            key={line.key}
            initial={{ opacity: 0, transform: move({ y: -6 }) }}
            animate={{ opacity: 1, ...settle }}
            exit={{ opacity: 0, transform: [REST, move({ y: -4 })] }}
            transition={transition}
            className="max-w-full"
          >
            {line.kind === "action" ? (
              <button
                type="button"
                onClick={line.onClick}
                className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-white/15 bg-black/75 py-2 pl-2 pr-4 text-sm font-bold text-white shadow-player-controls backdrop-blur-2xl transition hover:border-white/25 hover:bg-black/85 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-black">
                  <Play size={14} fill="currentColor" className="ml-0.5" />
                </span>
                <span className="truncate">{line.text}</span>
              </button>
            ) : (
              <div
                className={`flex max-w-full items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-semibold shadow-player-controls backdrop-blur-2xl ${
                  line.kind === "problem"
                    ? "border-rose-300/20 bg-rose-950/70 text-rose-100"
                    : "border-white/10 bg-black/70 text-white"
                }`}
              >
                {line.kind === "problem" ? (
                  <AlertCircle size={15} className="shrink-0 text-rose-200" />
                ) : (
                  <Loader2
                    size={15}
                    className="shrink-0 animate-spin text-[var(--accent)]"
                  />
                )}
                <span className="truncate">{line.text}</span>
              </div>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
