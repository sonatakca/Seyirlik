import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useLanguage } from "../../../i18n/LanguageContext";
import { describePartyNotice } from "../../../features/partyWatch/partyNotices";
import { formatTemplate } from "../../../lib/format";
import { DISC_COLOURS, type PartyDisc, type SahneParty } from "./sahneParty";

const SINE = "cubic-bezier(0.37, 0, 0.63, 1)";
const SINE_IN = "cubic-bezier(0.12, 0, 0.39, 0)";
const SINE_OUT = "cubic-bezier(0.61, 1, 0.88, 1)";
/** How long a line about what someone did stays under the stack. */
const NOTE_MS = 3500;

/** The balanced spinner: two opposed arcs of equal weight, centre still. */
function Ring({ color }: { color: string }) {
  return (
    <svg className="sahne-disc-ring" viewBox="0 0 42 42" aria-hidden="true">
      <g className="sahne-spin">
        <path d="M 21 3 A 18 18 0 0 1 39 21" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        <path d="M 21 39 A 18 18 0 0 1 3 21" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}

export function DiscFace({ disc, size }: { disc: PartyDisc; size?: number }) {
  const style = {
    "--c": disc.color,
    "--ink-on": disc.ink,
    ...(size ? { width: size, height: size, fontSize: Math.round(size * 0.4) } : {}),
  } as CSSProperties;
  return (
    <span className="sahne-disc-face" style={style} aria-hidden="true">
      {disc.initial}
    </span>
  );
}

/** A quadratic arc, sampled so the whole flight eases like a sine. */
function arcFrames(dx: number, dy: number, lift: number, s0: number) {
  const frames: Keyframe[] = [];
  const cx = dx / 2;
  const cy = Math.min(dy, 0) + lift;
  for (let i = 0; i <= 20; i += 1) {
    const u = i / 20;
    const t = 0.5 - 0.5 * Math.cos(Math.PI * u);
    const x = (1 - t) ** 2 * dx + 2 * (1 - t) * t * cx;
    const y = (1 - t) ** 2 * dy + 2 * (1 - t) * t * cy;
    frames.push({
      transform: `translate(${x}px, ${y}px) scale(${s0 + (1 - s0) * t})`,
      opacity: Math.min(1, t * 2.2),
      offset: u,
    });
  }
  return frames;
}

/**
 * The people in the party, beside the top buttons: a disc each.
 *
 * Someone joining flies out of the party button into their place while the
 * others make room; someone leaving shrinks away and the stack closes. While
 * the viewer is joining, three dots step in turn and grow into the people once
 * connected. A lost connection spreads the stack a little; the end of the
 * party fades it out from left to right. Whoever the group is waiting for has
 * a turning ring, and a line under the stack says what happened.
 */
export function SahnePartyStack({ party }: { party: SahneParty }) {
  const { t } = useLanguage();
  const nodes = useRef(new Map<string, HTMLElement>());
  const container = useRef<HTMLDivElement | null>(null);
  // Where each disc's own box stands on screen, without the animations on it.
  const lefts = useRef(new Map<string, number>());
  // How each newcomer enters, numbered so the effect starts each entry once.
  const [entries, setEntries] = useState<ReadonlyMap<string, { kind: "fly" | "grow"; gen: number }>>(new Map());
  const started = useRef(new Map<string, number>());

  // Who is drawn, in order, including the ones on their way out.
  const ids = party.discs.map((disc) => disc.id).join("|");
  const [seen, setSeen] = useState({ ids: "", connection: party.connection, gen: 0 });
  const [order, setOrder] = useState<string[]>([]);
  const [leaving, setLeaving] = useState<Map<string, PartyDisc>>(new Map());
  const [known, setKnown] = useState<Map<string, PartyDisc>>(new Map());
  if (seen.ids !== ids || seen.connection !== party.connection) {
    const current = new Set(party.discs.map((disc) => disc.id));
    const wasLive = seen.connection === "live" || seen.connection === "reconnecting";
    const growing = seen.connection === "joining" || seen.ids === "";
    const nextLeaving = new Map(leaving);
    for (const id of order) {
      if (!current.has(id) && !nextLeaving.has(id)) {
        const disc = known.get(id);
        if (disc) nextLeaving.set(id, disc);
      }
    }
    const kept = order.filter((id) => current.has(id) || nextLeaving.has(id));
    const added = party.discs.map((disc) => disc.id).filter((id) => !kept.includes(id));
    if (added.length > 0) {
      const nextEntries = new Map(entries);
      const gen = seen.gen + 1;
      for (const id of added) nextEntries.set(id, { kind: wasLive && !growing ? "fly" : "grow", gen });
      setEntries(nextEntries);
    }
    const nextKnown = new Map(known);
    for (const disc of party.discs) nextKnown.set(disc.id, disc);
    setKnown(nextKnown);
    setLeaving(nextLeaving);
    setOrder([...kept, ...added]);
    setSeen({ ids, connection: party.connection, gen: seen.gen + 1 });
  }

  const byId = new Map<string, PartyDisc>();
  for (const disc of party.discs) byId.set(disc.id, disc);
  const drawn = order
    .map((id) => byId.get(id) ?? leaving.get(id))
    .filter((disc): disc is PartyDisc => Boolean(disc));
  const waiting = new Set(party.waitingFor);

  // Glide what moved, bring in what arrived, send off what left.
  useLayoutEffect(() => {
    const button = document.querySelector<HTMLElement>("[data-party-button]");
    const leavingNow = drawn.filter((disc) => leaving.has(disc.id));
    let growIndex = 0;
    const origin = container.current?.getBoundingClientRect().left ?? 0;
    for (const disc of drawn) {
      const node = nodes.current.get(disc.id);
      if (!node) continue;
      const now = node.getBoundingClientRect();
      const left = origin + node.offsetLeft;
      const before = lefts.current.get(disc.id);
      const entry = entries.get(disc.id);
      if (entry && started.current.get(disc.id) !== entry.gen) {
        started.current.set(disc.id, entry.gen);
        if (entry.kind === "fly" && button) {
          const b = button.getBoundingClientRect();
          const dx = b.left + b.width / 2 - (now.left + now.width / 2);
          const dy = b.top + b.height / 2 - (now.top + now.height / 2);
          const flight = node.animate(arcFrames(dx, dy, 34, 0.4), { duration: 620, easing: "linear" });
          flight.finished
            .then(() =>
              node.animate(
                [{ transform: "scale(1, 1)" }, { transform: "scale(1.08, .92)", offset: 0.4 }, { transform: "scale(1, 1)" }],
                { duration: 280, easing: SINE },
              ),
            )
            .catch(() => {});
        } else {
          node.animate(
            [{ transform: "scale(.28)", opacity: 0.6 }, { transform: "scale(1)", opacity: 1 }],
            { duration: 420, delay: growIndex * 90, easing: SINE_OUT, fill: "backwards" },
          );
          growIndex += 1;
        }
      } else if (before !== undefined && !leaving.has(disc.id)) {
        const dx = before - left;
        if (Math.abs(dx) > 0.5) {
          node.animate([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], { duration: 460, easing: SINE });
        }
      }
      lefts.current.set(disc.id, left);
    }
    // People leave from left to right when several go at once (the end).
    leavingNow.forEach((disc, index) => {
      const node = nodes.current.get(disc.id);
      if (!node || node.dataset.leaving) return;
      node.dataset.leaving = "true";
      const exit = node.animate(
        [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(.5)", opacity: 0 }],
        { duration: 340, delay: index * 90, easing: SINE_IN, fill: "forwards" },
      );
      exit.finished
        .then(() => {
          lefts.current.delete(disc.id);
          setLeaving((current) => {
            const next = new Map(current);
            next.delete(disc.id);
            return next;
          });
          setOrder((current) => current.filter((id) => id !== disc.id));
        })
        .catch(() => {});
    });
  });

  // The line under the stack: a lost connection, then a wait, then news.
  const [note, setNote] = useState<{ id: number; text: string; actor: PartyDisc | null } | null>(null);
  const [noticeId, setNoticeId] = useState<number | null>(null);
  const notice = party.notice;
  if (notice && notice.id !== noticeId) {
    setNoticeId(notice.id);
    const text = describePartyNotice(notice, t);
    if (text) setNote({ id: notice.id, text, actor: party.actor });
  }
  useEffect(() => {
    if (!note) return undefined;
    const timer = window.setTimeout(
      () => setNote((current) => (current?.id === note.id ? null : current)),
      NOTE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [note]);

  let caption: { kind: "caps" | "note"; key: string; text: string; actor: PartyDisc | null } | null = null;
  if (party.connection === "reconnecting") {
    caption = { kind: "caps", key: "reconnecting", text: t("party.status.reconnecting"), actor: null };
  } else if (waiting.size > 0) {
    const names = drawn.filter((disc) => waiting.has(disc.id)).map((disc) => disc.name);
    caption = {
      kind: "caps",
      key: `waiting:${names.join(",")}`,
      text:
        names.length === 1
          ? formatTemplate(t("party.status.waitingFor"), { name: names[0] })
          : formatTemplate(t("party.status.waitingForMany"), { count: String(waiting.size) }),
      actor: null,
    };
  } else if (note) {
    caption = { kind: "note", key: `note:${note.id}`, text: note.text, actor: note.actor };
  } else if (party.commandFailed) {
    caption = { kind: "note", key: "failed", text: t("party.status.commandFailed"), actor: null };
  }

  if (party.connection === null && drawn.length === 0) return null;
  const spread = drawn.length - 1;

  return (
    <div
      ref={container}
      className="sahne-party"
      data-connection={party.connection ?? "none"}
      data-waiting={waiting.size > 0 ? "" : undefined}
      role="group"
      aria-label={t("party.title")}
    >
      {party.connection === "joining" ? (
        <span className="sahne-party-dots" aria-label={t("party.status.joining")}>
          {DISC_COLOURS.slice(0, 3).map((colour) => (
            <i key={colour.color} style={{ "--c": colour.color } as CSSProperties} />
          ))}
        </span>
      ) : null}
      {drawn.map((disc, index) => (
        <span
          key={disc.id}
          ref={(node) => {
            if (node) nodes.current.set(disc.id, node);
            else nodes.current.delete(disc.id);
          }}
          className="sahne-disc"
          data-self={disc.self ? "" : undefined}
          data-waiting={waiting.has(disc.id) ? "" : undefined}
          style={{ "--spread": `${(index - spread) * 10}px` } as CSSProperties}
          title={disc.name}
        >
          <DiscFace disc={disc} />
          <i className="sahne-disc-veil" />
          {waiting.has(disc.id) ? <Ring color={disc.color} /> : null}
        </span>
      ))}
      {caption ? (
        <div key={caption.key} className={`sahne-party-caption sahne-party-caption--${caption.kind}`} role="status">
          {caption.actor ? <DiscFace disc={caption.actor} /> : null}
          <span>{caption.text}</span>
        </div>
      ) : null}
    </div>
  );
}
