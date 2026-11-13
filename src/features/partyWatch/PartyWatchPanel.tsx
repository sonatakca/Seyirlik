import { useEffect, useState, type FormEvent } from "react";
import { Check, Copy, Link2, Loader2, LogOut, Plus, X } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { partyColours } from "./partyColours";
import type { PartyEndReason } from "./partySession";
import type { PartyParticipant } from "./partyWatchTypes";
import type { PartyStart, PartyWatch } from "./usePartyWatch";

interface PartyWatchPanelProps {
  party: PartyWatch;
  /** Where this viewer is now, so a new party starts there. */
  currentPlayback: () => PartyStart;
}

const END_MESSAGES: Record<PartyEndReason, TranslationKey> = {
  ended: "party.ended.ended",
  "not-found": "party.ended.notFound",
  "signed-out": "party.ended.signedOut",
  left: "party.ended.ended",
};

const primaryButton =
  "inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-bold text-black transition hover:brightness-110 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:cursor-not-allowed disabled:opacity-55";
const secondaryButton =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.08] px-3 text-sm font-bold text-white transition hover:border-white/20 hover:bg-white/[0.12] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45";
const quietButton =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-xl px-3 text-xs font-bold text-white/70 transition hover:bg-white/[0.09] hover:text-white active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

function initialOf(name: string): string {
  return (name.trim()[0] ?? "?").toLocaleUpperCase();
}

function memberNote(participant: PartyParticipant): TranslationKey | null {
  if (participant.presence !== "connected") return "party.member.reconnecting";
  if (participant.status === "away") return "party.member.away";
  if (participant.status === "loading" || participant.status === "stalled") {
    return "party.member.buffering";
  }
  return null;
}

export function PartyWatchPanel({
  party,
  currentPlayback,
}: PartyWatchPanelProps) {
  const { t } = useLanguage();
  const [joinInput, setJoinInput] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const state = party.state;
  const snapshot = state?.snapshot ?? null;
  // Everyone in their user's colour, the same on every member's screen.
  const colours = partyColours(snapshot?.participants ?? []);
  const connection = state?.connection ?? null;
  const inParty = party.groupId !== null && connection !== "ended";

  useEffect(() => {
    if (copyState === "idle") return undefined;
    const timer = setTimeout(() => setCopyState("idle"), 2_400);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copyInvite = async () => {
    if (!party.inviteUrl) return;
    try {
      await navigator.clipboard.writeText(party.inviteUrl);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    if (party.join(joinInput)) setJoinInput("");
  };

  const statusLine: { text: string; tone: "live" | "busy" | "idle" } =
    connection === "live"
      ? {
          text: t("party.watchingCount").replace(
            "{count}",
            String(snapshot?.participants.length ?? 1),
          ),
          tone: "live",
        }
      : connection === "reconnecting"
        ? { text: t("party.status.reconnecting"), tone: "busy" }
        : connection === "joining" || (party.groupId && !state)
          ? { text: t("party.status.joining"), tone: "busy" }
          : { text: t("party.intro"), tone: "idle" };

  return (
    <section
      className="seyirlik-party-panel w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-[rgba(18,18,20,0.96)] text-white shadow-[0_24px_90px_rgba(0,0,0,0.72)] backdrop-blur-2xl"
      aria-label={t("party.title")}
    >
      <header className="border-b border-white/10 px-4 py-3">
        <h2 className="text-base font-black">{t("party.title")}</h2>
        <p
          className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold leading-snug text-white/60"
          aria-live="polite"
        >
          {statusLine.tone !== "idle" ? (
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                statusLine.tone === "live"
                  ? "bg-[var(--accent)] shadow-accent-dot"
                  : "animate-pulse bg-amber-300"
              }`}
            />
          ) : null}
          <span>{statusLine.text}</span>
        </p>
      </header>

      <div className="space-y-3 p-3">
        {connection === "ended" && state?.endReason ? (
          <>
            <p className="rounded-xl bg-white/[0.05] px-3 py-2.5 text-[0.8125rem] font-semibold leading-snug text-white/75">
              {t(END_MESSAGES[state.endReason])}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={party.dismiss}
                className={secondaryButton}
              >
                <X size={15} />
                {t("party.dismiss")}
              </button>
              <button
                type="button"
                onClick={() => {
                  party.dismiss();
                  void party.create(currentPlayback());
                }}
                className={primaryButton}
              >
                <Plus size={15} />
                {t("party.createRoom")}
              </button>
            </div>
          </>
        ) : inParty ? (
          <>
            <ul
              className="space-y-1"
              aria-label={t("party.watchingCount").replace(
                "{count}",
                String(snapshot?.participants.length ?? 0),
              )}
            >
              {(snapshot?.participants ?? []).map((participant) => {
                const isSelf = participant.id === state?.selfId;
                const colour = colours.get(participant.userId);
                const note = memberNote(participant);
                const dim = participant.presence !== "connected";
                return (
                  <li
                    key={participant.id}
                    className={`flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-opacity duration-300 ${
                      dim ? "opacity-50" : "opacity-100"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-black"
                      style={{
                        background: colour?.color ?? "rgba(255,255,255,0.1)",
                        color: colour?.ink ?? "#fff",
                      }}
                    >
                      {initialOf(participant.displayName)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-bold">
                          {participant.displayName}
                        </span>
                        {isSelf ? (
                          <span className="shrink-0 text-xs font-semibold text-white/45">
                            {t("party.you")}
                          </span>
                        ) : null}
                        {participant.isOwner ? (
                          <span className="shrink-0 rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[0.625rem] font-black uppercase tracking-[0.12em] text-white/60">
                            {t("party.host")}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {note ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-white/50">
                        {note === "party.member.buffering" ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : null}
                        {t(note)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <div>
              <button
                type="button"
                onClick={() => void copyInvite()}
                disabled={!party.inviteUrl}
                className={primaryButton}
              >
                {copyState === "copied" ? (
                  <Check size={16} />
                ) : (
                  <Copy size={16} />
                )}
                {copyState === "copied"
                  ? t("party.inviteCopied")
                  : copyState === "failed"
                    ? t("party.copyFailed")
                    : t("party.copyInvite")}
              </button>
              <p className="mt-1.5 px-1 text-[0.6875rem] font-semibold leading-snug text-white/40">
                {t("party.inviteHint")}
              </p>
            </div>

            {party.errorKey ? (
              <p
                role="alert"
                className="px-1 text-xs font-semibold text-rose-200"
              >
                {t(party.errorKey)}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-2 border-t border-white/10 pt-2">
              <button
                type="button"
                onClick={() => void party.leave()}
                className={quietButton}
              >
                <LogOut size={14} />
                {t("party.leave")}
              </button>
              {snapshot &&
              snapshot.participants.find((p) => p.id === state?.selfId)
                ?.isOwner ? (
                <button
                  type="button"
                  onClick={() => void party.end()}
                  className={`${quietButton} text-rose-200/80 hover:bg-rose-500/10 hover:text-rose-200`}
                >
                  {t("party.endForEveryone")}
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void party.create(currentPlayback())}
              disabled={party.isCreating}
              className={primaryButton}
            >
              {party.isCreating ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Plus size={16} />
              )}
              {t("party.createRoom")}
            </button>

            <form
              onSubmit={submitJoin}
              className="seyirlik-party-join-row flex gap-2"
            >
              <label className="sr-only" htmlFor="party-join-input">
                {t("party.joinPlaceholder")}
              </label>
              <input
                id="party-join-input"
                value={joinInput}
                onChange={(event) => setJoinInput(event.target.value)}
                placeholder={t("party.joinPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                className="h-10 min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.06] px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/40 hover:border-white/20 focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/40"
              />
              <button
                type="submit"
                disabled={joinInput.trim().length === 0}
                className={secondaryButton}
              >
                <Link2 size={15} />
                {t("party.joinRoom")}
              </button>
            </form>

            {party.errorKey ? (
              <p
                role="alert"
                className="px-1 text-xs font-semibold text-rose-200"
              >
                {t(party.errorKey)}
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
