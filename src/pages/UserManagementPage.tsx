import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { getCachedSession, setAuthSession } from "../lib/authStorage";
import {
  getSignupConfig,
  listInvites,
  listLibraryChoices,
  listPeople,
  type Invite,
  type LibraryChoice,
  type Person,
} from "../lib/peopleApi";
import { setPageTitle } from "../lib/pageTitle";
import { useLanguage } from "../i18n/LanguageContext";
import { describeErrorForUser } from "../lib/userFacingError";
import { CastStrip, type PeopleView } from "./people/CastStrip";
import { InvitesSheet } from "./people/InvitesSheet";
import { PersonSheet } from "./people/PersonSheet";
import { fillTemplate, orderPeople } from "./people/peopleModel";

/** The view lives in the address, so a reload or a shared link keeps it. */
function viewFrom(params: URLSearchParams): PeopleView | null {
  if (params.get("view") === "invites") return { kind: "invites" };
  if (params.get("view") === "new") return { kind: "new" };
  const id = params.get("person");
  return id ? { kind: "person", id } : null;
}

function paramsFor(view: PeopleView): Record<string, string> {
  if (view.kind === "person") return { person: view.id };
  return { view: view.kind };
}

/**
 * People: everyone who can sign in to this Seyirlik, and the invites that let
 * someone make their own account. A strip of the cast across the top; the
 * chosen person, a new one, or the invites, opened below.
 */
export function UserManagementPage() {
  const { t, language } = useLanguage();
  const currentUserId = getCachedSession()?.userId ?? null;
  const [params, setParams] = useSearchParams();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [libraries, setLibraries] = useState<LibraryChoice[]>([]);
  const [signupOpen, setSignupOpen] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setPageTitle(`${t("people.title")} · ${t("devtools.title")} · Seyirlik`, {
      canonicalPath: "/dev/users",
      robots: "noindex, nofollow",
    });
  }, [t]);

  const load = useCallback(async () => {
    try {
      // People are the page; the rest only adds to it, so their failure
      // leaves the page usable rather than blank.
      const [nextPeople, nextInvites, nextLibraries, config] =
        await Promise.all([
          listPeople(),
          listInvites().catch(() => [] as Invite[]),
          listLibraryChoices().catch(() => [] as LibraryChoice[]),
          getSignupConfig().catch(() => null),
        ]);
      setPeople(nextPeople);
      setInvites(nextInvites);
      setLibraries(nextLibraries);
      setSignupOpen(config ? config.enabled : null);
    } catch (error) {
      setLoadError(describeErrorForUser(error, t));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const ordered = useMemo(
    () => (people ? orderPeople(people, language) : []),
    [people, language],
  );

  // Nothing chosen, or someone who no longer exists: open the first person,
  // which is you or another administrator.
  const requested = viewFrom(params);
  const view: PeopleView | null =
    requested?.kind === "person" &&
    people &&
    !people.some((person) => person.id === requested.id)
      ? null
      : requested;
  const shown: PeopleView | null =
    view ?? (ordered[0] ? { kind: "person", id: ordered[0].id } : null);

  const select = (next: PeopleView) => {
    setNotice(null);
    setParams(paramsFor(next), { replace: true });
  };

  const savedPerson = (person: Person, message: string) => {
    setPeople((current) => {
      const rest = (current ?? []).filter((entry) => entry.id !== person.id);
      return [...rest, person];
    });
    if (person.id === currentUserId) {
      const session = getCachedSession();
      if (session)
        setAuthSession({ ...session, displayName: person.displayName });
    }
    setNotice(message);
    setParams(paramsFor({ kind: "person", id: person.id }), { replace: true });
  };

  const deletedPerson = (id: string, message: string) => {
    const remaining = ordered.filter((person) => person.id !== id);
    setPeople((current) =>
      (current ?? []).filter((person) => person.id !== id),
    );
    setNotice(message);
    if (remaining[0]) {
      setParams(paramsFor({ kind: "person", id: remaining[0].id }), {
        replace: true,
      });
    }
  };

  const changedInvite = (invite: Invite) => {
    setInvites((current) => {
      const exists = current.some((entry) => entry.id === invite.id);
      return exists
        ? current.map((entry) => (entry.id === invite.id ? invite : entry))
        : [invite, ...current];
    });
  };

  const selectedPerson =
    shown?.kind === "person"
      ? (ordered.find((person) => person.id === shown.id) ?? null)
      : null;
  const openInvites = invites.filter(
    (invite) => invite.state === "open",
  ).length;
  const administrators = ordered.filter(
    (person) => person.isAdministrator,
  ).length;

  return (
    <div className="w-full space-y-6 pb-10">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <h1 className="text-3xl font-black text-white">
            {t("people.title")}
          </h1>
          <p className="mt-1 text-sm font-semibold tabular-nums text-white/55">
            {people
              ? fillTemplate(t("people.summary"), {
                  people: ordered.length,
                  administrators,
                  invites: openInvites,
                })
              : t("people.loading")}
          </p>
        </div>
        {notice ? (
          <p
            role="status"
            className="flex items-center gap-2 text-sm font-bold text-emerald-300"
          >
            <CheckCircle2 size={16} />
            {notice}
          </p>
        ) : null}
      </header>

      {loadError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-300/25 px-4 py-3"
        >
          <p className="flex items-center gap-2 text-sm font-bold text-rose-100">
            <CircleAlert size={16} />
            {t("people.loadFailed")} {loadError}
          </p>
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              void load();
            }}
            className="min-h-9 rounded-lg border border-white/15 bg-white/10 px-3.5 text-sm font-bold text-white transition-colors hover:bg-white/[0.16]"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      {people === null && !loadError ? (
        <div className="flex min-h-40 items-center justify-center">
          <Loader2 size={26} className="animate-spin text-white/50" />
        </div>
      ) : null}

      {people && shown ? (
        <>
          <CastStrip
            people={ordered}
            currentUserId={currentUserId}
            view={shown}
            openInvites={openInvites}
            onSelect={select}
          />

          <div className="border-t border-white/10 pt-4">
            {shown.kind === "invites" ? (
              <InvitesSheet
                invites={invites}
                signupOpen={signupOpen}
                onChanged={changedInvite}
              />
            ) : (
              <PersonSheet
                key={shown.kind === "new" ? "new" : shown.id}
                person={selectedPerson}
                libraries={libraries}
                isCurrentUser={selectedPerson?.id === currentUserId}
                onSaved={savedPerson}
                onDeleted={deletedPerson}
              />
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
