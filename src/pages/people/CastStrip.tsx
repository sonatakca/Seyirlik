import { useEffect, useRef } from "react";
import { Plus, ShieldCheck, Ticket } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { Person } from "../../lib/peopleApi";
import { initialsOf } from "./peopleModel";

export type PeopleView =
  | { kind: "person"; id: string }
  | { kind: "new" }
  | { kind: "invites" };

/** A monogram: the person's initials, never a stock avatar. */
export function Monogram({
  person,
  name,
  size,
}: {
  person?: Pick<Person, "isAdministrator" | "isDisabled">;
  name: string;
  size: "strip" | "sheet";
}) {
  const box =
    size === "sheet" ? "h-[4.5rem] w-[4.5rem] text-2xl" : "h-12 w-12 text-base";
  return (
    <span aria-hidden className="relative shrink-0">
      <span
        className={`flex items-center justify-center rounded-full font-black tracking-wide ${box} ${
          person?.isDisabled
            ? "border border-dashed border-white/25 text-white/40"
            : "bg-white/[0.1] text-white/90"
        }`}
      >
        {initialsOf(name) || "·"}
      </span>
      {person?.isAdministrator ? (
        <span
          className={`absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-[#050607] text-white/80 ring-2 ring-[#050607] ${
            size === "sheet" ? "h-6 w-6" : "h-5 w-5"
          }`}
        >
          <ShieldCheck size={size === "sheet" ? 15 : 13} strokeWidth={2.4} />
        </span>
      ) : null}
    </span>
  );
}

const TILE =
  "group flex w-[8.5rem] shrink-0 snap-start flex-col items-center gap-2.5 rounded-2xl border px-3 pb-3 pt-4 text-center transition-[background-color,border-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black";

/**
 * Everyone, side by side: the cast list of this Seyirlik. Choosing a tile
 * opens that person below. "You are here" is plain white, never the accent.
 */
export function CastStrip({
  people,
  currentUserId,
  view,
  openInvites,
  onSelect,
}: {
  people: Person[];
  currentUserId: string | null;
  view: PeopleView;
  openInvites: number;
  onSelect: (view: PeopleView) => void;
}) {
  const { t } = useLanguage();
  const listRef = useRef<HTMLUListElement>(null);
  const selectedKey = view.kind === "person" ? view.id : view.kind;

  // On a phone the strip scrolls; whoever is open is kept in sight, including
  // when the page opens on someone near the end of it.
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedKey]);

  return (
    <nav aria-label={t("people.stripLabel")}>
      <ul
        ref={listRef}
        className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-2 pt-1 [scrollbar-color:rgba(255,255,255,0.2)_transparent] [scrollbar-width:thin] lg:flex-wrap lg:overflow-visible"
      >
        {people.map((person) => {
          const selected = view.kind === "person" && view.id === person.id;
          return (
            <li key={person.id}>
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect({ kind: "person", id: person.id })}
                className={`${TILE} ${
                  selected
                    ? "border-white/30 bg-white/[0.08] text-white"
                    : "border-white/[0.07] text-white/70 hover:border-white/15 hover:bg-white/[0.04] hover:text-white"
                }`}
              >
                <Monogram
                  person={person}
                  name={person.displayName}
                  size="strip"
                />
                <span className="w-full min-w-0">
                  <span
                    className={`block truncate text-sm font-bold ${
                      person.isDisabled
                        ? "line-through decoration-white/40"
                        : ""
                    }`}
                  >
                    {person.displayName}
                  </span>
                  <span className="mt-0.5 block truncate text-xs font-semibold text-white/50">
                    {person.id === currentUserId
                      ? t("people.you")
                      : `@${person.username}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}

        <li>
          <button
            type="button"
            aria-current={view.kind === "new" ? "true" : undefined}
            onClick={() => onSelect({ kind: "new" })}
            className={`${TILE} border-dashed ${
              view.kind === "new"
                ? "border-white/40 bg-white/[0.06] text-white"
                : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
            }`}
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-current">
              <Plus size={20} />
            </span>
            <span className="text-sm font-bold">{t("people.newPerson")}</span>
          </button>
        </li>

        <li>
          <button
            type="button"
            aria-current={view.kind === "invites" ? "true" : undefined}
            onClick={() => onSelect({ kind: "invites" })}
            className={`${TILE} border-dashed ${
              view.kind === "invites"
                ? "border-white/40 bg-white/[0.06] text-white"
                : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
            }`}
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-current">
              <Ticket size={19} />
            </span>
            <span className="w-full min-w-0">
              <span className="block text-sm font-bold">
                {t("people.invites")}
              </span>
              <span className="mt-0.5 block text-xs font-semibold tabular-nums text-white/50">
                {openInvites === 0
                  ? t("people.invitesNoneOpen")
                  : t("people.invitesOpen").replace(
                      "{count}",
                      String(openInvites),
                    )}
              </span>
            </span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
