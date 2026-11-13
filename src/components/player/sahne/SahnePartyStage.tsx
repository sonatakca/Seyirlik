import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Pause, Play } from "lucide-react";
import { useLanguage } from "../../../i18n/LanguageContext";
import { formatPartyTime } from "../../../features/partyWatch/partyNotices";
import type { PartyLocalState } from "../../../features/partyWatch/usePartyPlayback";
import { DiscFace } from "./SahnePartyStack";
import type { Rect } from "./sahneGeometry";
import type { PartyDisc, SahneParty } from "./sahneParty";

const SINE = "cubic-bezier(0.37, 0, 0.63, 1)";
const SINE_OUT = "cubic-bezier(0.61, 1, 0.88, 1)";

interface Jump {
  id: number;
  from: number;
  to: number;
  actor: PartyDisc | null;
}

/**
 * Someone else's jump, drawn on the seek bar: first where it started and where
 * it lands, then their name travels from one to the other, filling the way it
 * went, and the landing names the time.
 */
function JumpTrail({
  jump,
  bar,
  duration,
  onLanded,
  onDone,
}: {
  jump: Jump;
  bar: { x: number; y: number; w: number };
  duration: number;
  /** The trail is drawn on the controls: they must stay until it is done. */
  onLanded: () => void;
  onDone: () => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const [landed, setLanded] = useState(false);
  const color = jump.actor?.color ?? "var(--accent)";
  const ink = jump.actor?.ink ?? "#0a0b0c";
  const xa = bar.x + (bar.w * jump.from) / duration;
  const xb = bar.x + (bar.w * jump.to) / duration;
  const left = Math.min(xa, xb);
  const width = Math.abs(xb - xa);
  const forward = xb >= xa;

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const ends = [...el.querySelectorAll<HTMLElement>("[data-end]")];
    const tag = el.querySelector<HTMLElement>("[data-tag]");
    const trail = el.querySelector<HTMLElement>("[data-trail]");
    let cancelled = false;
    const all: Animation[] = [];
    const run = async () => {
      ends.forEach((end, index) =>
        all.push(end.animate([{ transform: "scale(.4)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 240, delay: index * 90, easing: SINE_OUT, fill: "both" })),
      );
      if (tag) all.push(tag.animate([{ opacity: 0, transform: `translate(${xa}px, 0) translateX(-50%) translateY(6px)` }, { opacity: 1, transform: `translate(${xa}px, 0) translateX(-50%)` }], { duration: 260, delay: 360, easing: SINE_OUT, fill: "both" }));
      const travel = Math.min(1100, Math.max(600, width * 1.4));
      if (trail) all.push(trail.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: travel, delay: 620, easing: SINE, fill: "both" }));
      if (tag) {
        const move = tag.animate([{ transform: `translate(${xa}px, 0) translateX(-50%)` }, { transform: `translate(${xb}px, 0) translateX(-50%)` }], { duration: travel, delay: 620, easing: SINE, fill: "forwards" });
        all.push(move);
        await move.finished;
      }
      if (cancelled) return;
      setLanded(true);
      onLanded();
      await new Promise((resolve) => window.setTimeout(resolve, 1600));
      if (cancelled) return;
      const out = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 360, easing: SINE, fill: "forwards" });
      all.push(out);
      await out.finished;
      if (!cancelled) onDone();
    };
    run().catch(() => {});
    return () => {
      cancelled = true;
      all.forEach((animation) => animation.cancel());
    };
    // One run per jump; the callbacks are stable for its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump.id]);

  return (
    <div ref={root} className="sahne-jump" aria-hidden="true" style={{ "--c": color, "--ink-on": ink, top: bar.y } as CSSProperties}>
      <i data-trail className="sahne-jump-trail" style={{ left, width, transformOrigin: forward ? "0 50%" : "100% 50%" }} />
      <i data-end className="sahne-jump-end" style={{ left: xa }} />
      <i data-end className="sahne-jump-end" style={{ left: xb }} />
      <span data-tag className="sahne-jump-tag">
        {landed ? formatPartyTime(jump.to * 1000) : (jump.actor?.name ?? "")}
      </span>
    </div>
  );
}

/**
 * What the party does to the picture: a pause or play signed with the disc of
 * whoever did it, someone's jump traced on the seek bar, and the card that
 * asks a viewer who dropped out of the party to rejoin it.
 */
export function SahnePartyStage({
  party,
  picture,
  bar,
  currentTime,
  duration,
  localState,
  onRejoin,
  onShowControls,
}: {
  party: SahneParty;
  /** Where the picture is now. */
  picture: Rect;
  /** The seek bar: its left edge, centre line and width. */
  bar: { x: number; y: number; w: number };
  currentTime: number;
  duration: number;
  localState: PartyLocalState | null;
  onRejoin: () => void;
  onShowControls: () => void;
}) {
  const { t } = useLanguage();
  const [badge, setBadge] = useState<{ id: number; kind: "play" | "pause"; actor: PartyDisc | null } | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const [handled, setHandled] = useState<number | null>(null);
  // Where playback stood a moment ago, for a jump's starting point: the
  // player may already have moved by the time the news is drawn.
  const [times, setTimes] = useState({ now: currentTime, before: currentTime });
  if (times.now !== currentTime) setTimes({ now: currentTime, before: times.now });
  const notice = party.notice;
  if (notice && notice.id !== handled) {
    setHandled(notice.id);
    const kind = notice.cause.kind;
    if (kind === "play" || kind === "pause") {
      setBadge({ id: notice.id, kind, actor: party.actor });
    } else if (kind === "seek" && duration > 0) {
      const to = notice.snapshot.positionMs / 1000;
      const from = Math.abs(currentTime - to) < 1 ? times.before : currentTime;
      setJump({ id: notice.id, from, to, actor: party.actor });
    }
  }
  useEffect(() => {
    if (jump) onShowControls();
  }, [jump, onShowControls]);
  useEffect(() => {
    if (!badge) return undefined;
    const timer = window.setTimeout(() => setBadge((current) => (current?.id === badge.id ? null : current)), 1500);
    return () => window.clearTimeout(timer);
  }, [badge]);

  const out = party.connection === "live" && (localState === "blocked" || localState === "paused-locally");
  const others = party.discs.filter((disc) => !disc.self).slice(0, 4);
  const cx = picture.x + picture.w / 2;
  const cy = picture.y + picture.h / 2;

  return (
    <>
      {badge ? (
        <div key={badge.id} className="sahne-party-badge" style={{ left: cx, top: cy }} aria-hidden="true">
          <span className="sahne-party-badge-glyph">
            {badge.kind === "pause" ? <Pause size={44} fill="currentColor" strokeWidth={2} /> : <Play size={44} fill="currentColor" strokeWidth={2} className="ml-1" />}
          </span>
          {badge.actor ? (
            <span className="sahne-party-badge-who">
              <DiscFace disc={badge.actor} size={34} />
            </span>
          ) : null}
        </div>
      ) : null}
      {jump ? (
        <JumpTrail
          key={jump.id}
          jump={jump}
          bar={bar}
          duration={duration}
          onLanded={onShowControls}
          onDone={() => setJump(null)}
        />
      ) : null}
      {out ? (
        <>
          <div
            className="sahne-party-dim"
            style={{ left: picture.x, top: picture.y, width: picture.w, height: picture.h }}
            aria-hidden="true"
          />
          <div className="sahne-party-card" style={{ left: cx, top: cy }} role="dialog" aria-label={t("player.party.droppedTitle")} data-party-watch-root>
            {others.length > 0 ? (
              <span className="sahne-party-card-people">
                {others.map((disc) => (
                  <DiscFace key={disc.id} disc={disc} size={40} />
                ))}
              </span>
            ) : null}
            <h2>{t("player.party.droppedTitle")}</h2>
            <p>{t("player.party.droppedBody")}</p>
            <button type="button" onClick={onRejoin} autoFocus>
              {t("player.party.rejoin")}
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
