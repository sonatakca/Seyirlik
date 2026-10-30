import { useMemo, useState, type FormEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AtSign,
  CheckCircle2,
  CircleAlert,
  KeyRound,
  Loader2,
  Lock,
  Trash2,
} from "lucide-react";
import { OwnApiClientError } from "../../api/ownApi/client";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  createPerson,
  deletePerson,
  setPassword,
  updatePerson,
  type LibraryChoice,
  type Person,
} from "../../lib/peopleApi";
import { describeErrorForUser } from "../../lib/userFacingError";
import { Monogram } from "./CastStrip";
import {
  Field,
  Panel,
  Segmented,
  SwitchRow,
  fieldClassName,
} from "./PeopleControls";
import {
  CONTENT_AGE_LIMITS,
  changesBetween,
  draftOf,
  emptyDraft,
  fillTemplate,
  formatDate,
  type PersonDraft,
} from "./peopleModel";

type Notice = { tone: "success" | "error"; text: string } | null;

const ERROR_KEYS: Record<string, TranslationKey> = {
  USERNAME_TAKEN: "people.error.usernameTaken",
  LAST_ADMINISTRATOR: "people.error.lastAdministrator",
  SELF_DELETE_FORBIDDEN: "people.error.selfDelete",
  USER_NOT_FOUND: "people.error.notFound",
};

function describe(error: unknown, t: (key: TranslationKey) => string): string {
  if (error instanceof OwnApiClientError) {
    const key = ERROR_KEYS[error.code];
    if (key) return t(key);
    // The server names the rule a name broke; that sentence is the help.
    if (error.code === "VALIDATION_FAILED") return error.message;
  }
  return describeErrorForUser(error, t);
}

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const Icon = notice.tone === "success" ? CheckCircle2 : CircleAlert;
  return (
    <p
      role={notice.tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2 text-sm font-bold ${
        notice.tone === "success" ? "text-emerald-300" : "text-rose-200"
      }`}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      {notice.text}
    </p>
  );
}

/**
 * One person, opened below the strip: who they are, what they may do, what
 * they may see, and — set apart at the foot — removing them.
 *
 * `person` absent is a new account. The same sheet makes it, so a new person
 * is set up completely before anyone signs in as them.
 */
export function PersonSheet({
  person,
  libraries,
  isCurrentUser,
  onSaved,
  onDeleted,
}: {
  person: Person | null;
  libraries: LibraryChoice[];
  isCurrentUser: boolean;
  onSaved: (person: Person, notice: string) => void;
  onDeleted: (id: string, notice: string) => void;
}) {
  const { t, language } = useLanguage();
  const reduceMotion = useReducedMotion();
  const base = useMemo(
    () => (person ? draftOf(person) : emptyDraft()),
    [person],
  );
  const [draft, setDraft] = useState<PersonDraft>(base);
  const [username, setUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [passwordNotice, setPasswordNotice] = useState<Notice>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<Notice>(null);

  // Saved: start again from what is now stored. (A different person is a
  // different sheet; the page keys it by id.)
  const [shownBase, setShownBase] = useState(base);
  if (shownBase !== base) {
    setShownBase(base);
    setDraft(base);
    setNotice(null);
  }

  const isNew = person === null;
  const changes = changesBetween(base, draft);
  const dirty = isNew || Object.keys(changes).length > 0;
  const set = <Key extends keyof PersonDraft>(
    key: Key,
    value: PersonDraft[Key],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  const shownName =
    draft.displayName.trim() ||
    (isNew ? t("people.newPersonTitle") : (person?.displayName ?? ""));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    if (!draft.displayName.trim()) {
      setNotice({ tone: "error", text: t("people.error.displayName") });
      return;
    }
    if (isNew && !username.trim()) {
      setNotice({ tone: "error", text: t("people.error.username") });
      return;
    }

    setSaving(true);
    try {
      if (isNew) {
        const created = await createPerson({
          username: username.trim(),
          displayName: draft.displayName.trim(),
          password: newPassword,
          isAdministrator: draft.isAdministrator,
        });
        // Created with the server's defaults; the rest of the form is
        // applied on top so the account is ready as drawn.
        const rest = changesBetween(
          {
            ...emptyDraft(),
            displayName: created.displayName,
            isAdministrator: created.isAdministrator,
          },
          draft,
        );
        delete rest.displayName;
        const finished =
          Object.keys(rest).length > 0
            ? await updatePerson(created.id, rest)
            : created;
        onSaved(
          finished,
          fillTemplate(t("people.created"), { name: finished.displayName }),
        );
      } else if (person) {
        const saved = await updatePerson(person.id, changes);
        onSaved(
          saved,
          fillTemplate(t("people.saved"), { name: saved.displayName }),
        );
      }
    } catch (error) {
      setNotice({ tone: "error", text: describe(error, t) });
    } finally {
      setSaving(false);
    }
  };

  const applyPassword = async (value: string) => {
    if (!person) return;
    setPasswordBusy(true);
    setPasswordNotice(null);
    try {
      await setPassword(person.id, value);
      setNewPassword("");
      setPasswordNotice({
        tone: "success",
        text: value ? t("people.passwordSet") : t("people.passwordRemoved"),
      });
    } catch (error) {
      setPasswordNotice({ tone: "error", text: describe(error, t) });
    } finally {
      setPasswordBusy(false);
    }
  };

  const remove = async () => {
    if (!person) return;
    setDeleting(true);
    setDeleteNotice(null);
    try {
      await deletePerson(person.id);
      onDeleted(
        person.id,
        fillTemplate(t("people.deleted"), { name: person.displayName }),
      );
    } catch (error) {
      setDeleteNotice({ tone: "error", text: describe(error, t) });
      setDeleting(false);
    }
  };

  const facts: string[] = [];
  if (person) {
    facts.push(`@${person.username}`);
    facts.push(
      person.isAdministrator
        ? t("people.role.administrator")
        : t("people.role.viewer"),
    );
    if (person.isDisabled) facts.push(t("people.state.disabled"));
    facts.push(
      person.lastLoginAt
        ? fillTemplate(t("people.lastSignIn"), {
            date: formatDate(person.lastLoginAt, language),
          })
        : t("people.neverSignedIn"),
    );
    if (person.joinedByInvite) facts.push(t("people.joinedByInvite"));
  }

  const ageOptions = [
    { value: null, label: t("people.age.none") },
    ...CONTENT_AGE_LIMITS.map((age) => ({ value: age, label: `${age}+` })),
  ];
  const confirmTarget = person ? person.username : "";

  return (
    <form onSubmit={save} className="space-y-5" aria-label={shownName}>
      <header className="flex items-center gap-5 pt-2">
        <Monogram
          person={isNew ? undefined : { ...draft }}
          name={draft.displayName || (person?.displayName ?? "")}
          size="sheet"
        />
        <div className="min-w-0">
          <h2 className="line-clamp-2 break-words text-3xl font-black leading-tight text-white sm:text-4xl">
            {shownName}
          </h2>
          <p className="mt-1 text-sm font-semibold text-white/55">
            {isNew
              ? t("people.newPersonLead")
              : facts.map((fact, index) => (
                  <span key={fact}>
                    {index > 0 ? (
                      <span aria-hidden className="mx-2 text-white/25">
                        ·
                      </span>
                    ) : null}
                    {fact}
                  </span>
                ))}
          </p>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={t("people.section.identity")}>
          <div className="divide-y divide-white/[0.07]">
            <Field
              htmlFor="person-display-name"
              label={t("people.displayName")}
              hint={t("people.displayNameHint")}
            >
              <input
                id="person-display-name"
                value={draft.displayName}
                maxLength={100}
                autoComplete="off"
                placeholder={t("people.displayNamePlaceholder")}
                onChange={(event) => set("displayName", event.target.value)}
                className={fieldClassName}
              />
            </Field>

            <Field
              htmlFor="person-username"
              label={t("people.username")}
              hint={
                isNew ? t("people.usernameHintNew") : t("people.usernameHint")
              }
            >
              {isNew ? (
                <div className="relative">
                  <AtSign
                    size={15}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40"
                  />
                  <input
                    id="person-username"
                    value={username}
                    maxLength={64}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => setUsername(event.target.value)}
                    className={`${fieldClassName} pl-9`}
                  />
                </div>
              ) : (
                <p
                  id="person-username"
                  className="flex min-h-11 items-center gap-2 rounded-xl border border-white/[0.07] px-3.5 text-sm font-semibold text-white/75"
                >
                  <Lock size={14} className="shrink-0 text-white/40" />
                  <span className="truncate">@{person?.username}</span>
                </p>
              )}
            </Field>

            <Field
              htmlFor="person-password"
              label={isNew ? t("people.password") : t("people.newPassword")}
              hint={
                isNew ? t("people.passwordHintNew") : t("people.passwordHint")
              }
            >
              <div className="flex gap-2">
                <input
                  id="person-password"
                  type="password"
                  value={newPassword}
                  autoComplete="new-password"
                  onChange={(event) => setNewPassword(event.target.value)}
                  className={fieldClassName}
                />
                {isNew ? null : (
                  <button
                    type="button"
                    disabled={!newPassword || passwordBusy}
                    onClick={() => void applyPassword(newPassword)}
                    className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-white/15 bg-white/10 px-3.5 text-sm font-bold text-white transition-colors hover:bg-white/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {passwordBusy ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <KeyRound size={15} />
                    )}
                    {t("people.setPassword")}
                  </button>
                )}
              </div>
              {isNew ? null : (
                <button
                  type="button"
                  disabled={passwordBusy}
                  onClick={() => void applyPassword("")}
                  className="mt-2 text-xs font-bold text-white/55 underline decoration-white/20 underline-offset-4 transition hover:text-white hover:decoration-white/50 disabled:opacity-40"
                >
                  {t("people.removePassword")}
                </button>
              )}
              <div className="mt-2">
                <NoticeLine notice={passwordNotice} />
              </div>
            </Field>
          </div>
        </Panel>

        <Panel title={t("people.section.access")}>
          <div className="divide-y divide-white/[0.07]">
            <SwitchRow
              label={t("people.access.administrator")}
              description={
                isCurrentUser
                  ? t("people.access.selfProtected")
                  : t("people.access.administratorDescription")
              }
              checked={isCurrentUser || draft.isAdministrator}
              disabled={isCurrentUser}
              onChange={(value) => set("isAdministrator", value)}
            />
            <SwitchRow
              label={t("people.access.signIn")}
              description={
                isCurrentUser
                  ? t("people.access.selfProtected")
                  : t("people.access.signInDescription")
              }
              checked={isCurrentUser || !draft.isDisabled}
              disabled={isCurrentUser}
              onChange={(value) => set("isDisabled", !value)}
            />
            <SwitchRow
              label={t("people.access.playback")}
              description={t("people.access.playbackDescription")}
              checked={draft.allowPlayback}
              onChange={(value) => set("allowPlayback", value)}
            />
            <SwitchRow
              label={t("people.access.downloads")}
              description={
                draft.isAdministrator
                  ? t("people.access.downloadsAdmin")
                  : t("people.access.downloadsDescription")
              }
              checked={draft.isAdministrator || draft.allowDownloads}
              disabled={draft.isAdministrator}
              onChange={(value) => set("allowDownloads", value)}
            />
          </div>
        </Panel>

        <Panel title={t("people.section.sees")}>
          <div className="divide-y divide-white/[0.07]">
            <div className="py-3.5">
              <p className="text-sm font-bold text-white/90">
                {t("people.age.label")}
              </p>
              <p className="mb-3 mt-0.5 text-xs font-medium leading-5 text-white/50">
                {isCurrentUser
                  ? t("people.age.self")
                  : t("people.age.description")}
              </p>
              <Segmented
                label={t("people.age.label")}
                value={draft.maxContentAge}
                options={ageOptions}
                fill
                disabled={isCurrentUser}
                onChange={(value) => set("maxContentAge", value)}
              />
            </div>
            {draft.maxContentAge !== null ? (
              <SwitchRow
                label={t("people.age.unrated")}
                description={t("people.age.unratedDescription")}
                checked={draft.allowUnratedContent}
                onChange={(value) => set("allowUnratedContent", value)}
              />
            ) : null}
            <SwitchRow
              label={t("people.libraries.all")}
              description={t("people.libraries.allDescription")}
              checked={draft.allowAllLibraries}
              onChange={(value) => set("allowAllLibraries", value)}
            />
            {draft.allowAllLibraries ? null : (
              <fieldset className="py-3">
                <legend className="sr-only">
                  {t("people.libraries.pick")}
                </legend>
                {libraries.length === 0 ? (
                  <p className="text-xs font-medium text-white/50">
                    {t("people.libraries.none")}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {libraries.map((library) => {
                      const checked = draft.libraryIds.includes(library.id);
                      return (
                        <li key={library.id}>
                          <label className="flex min-h-9 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm font-semibold text-white/80 transition-colors hover:bg-white/[0.05]">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                set(
                                  "libraryIds",
                                  checked
                                    ? draft.libraryIds.filter(
                                        (id) => id !== library.id,
                                      )
                                    : [...draft.libraryIds, library.id],
                                )
                              }
                              className="h-4 w-4 accent-[var(--accent)]"
                            />
                            {library.name}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </fieldset>
            )}
          </div>
        </Panel>
      </div>

      {/* Save lives with the changes it saves: it appears when there is
          something to save, and holds still while the page scrolls. */}
      <AnimatePresence initial={false}>
        {dirty || notice ? (
          <motion.div
            key="save-bar"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.18 } }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            className="sticky bottom-[calc(env(safe-area-inset-bottom)+5.25rem)] z-10 flex lg:bottom-4 flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/15 bg-[#0c0d0f] px-4 py-3 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
          >
            <div className="min-w-0">
              {notice ? (
                <NoticeLine notice={notice} />
              ) : (
                <p className="text-sm font-semibold text-white/65">
                  {isNew ? t("people.readyToCreate") : t("people.unsaved")}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              {dirty && !isNew ? (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(base);
                    setNotice(null);
                  }}
                  className="min-h-10 rounded-lg px-4 text-sm font-bold text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  {t("people.discard")}
                </button>
              ) : null}
              {dirty ? (
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[var(--accent)] px-4 text-sm font-bold text-zinc-950 transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-wait disabled:opacity-60"
                >
                  {saving ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : null}
                  {isNew ? t("people.create") : t("people.save")}
                </button>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {person ? (
        <section
          aria-labelledby="danger-heading"
          className="rounded-2xl border border-rose-300/20 px-5 py-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 max-w-xl">
              <h3 id="danger-heading" className="text-sm font-black text-white">
                {fillTemplate(t("people.delete.title"), {
                  name: person.displayName,
                })}
              </h3>
              <p className="mt-1 text-xs font-medium leading-5 text-white/55">
                {isCurrentUser
                  ? t("people.error.selfDelete")
                  : t("people.delete.description")}
              </p>
            </div>
            {confirmingDelete ? null : (
              <button
                type="button"
                disabled={isCurrentUser}
                onClick={() => setConfirmingDelete(true)}
                className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-rose-300/30 bg-white/[0.06] px-4 text-sm font-bold text-rose-100 transition-colors hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 size={15} />
                {t("people.delete.start")}
              </button>
            )}
          </div>

          <AnimatePresence initial={false}>
            {confirmingDelete ? (
              <motion.div
                key="confirm"
                initial={{ opacity: 0, height: 0 }}
                animate={{
                  opacity: 1,
                  height: "auto",
                  transition: { duration: 0.2 },
                }}
                exit={{ opacity: 0, height: 0, transition: { duration: 0.14 } }}
                className="overflow-hidden"
              >
                <div className="mt-4 border-t border-rose-300/15 pt-4">
                  <label
                    htmlFor="delete-confirm"
                    className="block text-xs font-semibold text-white/70"
                  >
                    {fillTemplate(t("people.delete.confirmLabel"), {
                      username: confirmTarget,
                    })}
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <input
                      id="delete-confirm"
                      value={deleteConfirmation}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      autoFocus
                      onChange={(event) =>
                        setDeleteConfirmation(event.target.value)
                      }
                      placeholder={confirmTarget}
                      className={`${fieldClassName} max-w-xs focus:border-rose-300/60`}
                    />
                    <button
                      type="button"
                      disabled={
                        deleting ||
                        deleteConfirmation
                          .trim()
                          .replace(/^@/, "")
                          .toLowerCase() !== confirmTarget
                      }
                      onClick={() => void remove()}
                      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-rose-300/50 bg-rose-300/[0.14] px-4 text-sm font-black text-rose-50 transition-colors hover:bg-rose-300/[0.22] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {deleting ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : (
                        <Trash2 size={15} />
                      )}
                      {t("people.delete.confirm")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingDelete(false);
                        setDeleteConfirmation("");
                      }}
                      className="min-h-11 rounded-xl px-4 text-sm font-bold text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      {t("people.delete.cancel")}
                    </button>
                  </div>
                  <div className="mt-2">
                    <NoticeLine notice={deleteNotice} />
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>
      ) : null}
    </form>
  );
}
