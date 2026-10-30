import { useState, type FormEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  Loader2,
  Ticket,
  X,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  createInvite,
  revokeInvite,
  type Invite,
  type InviteState,
} from "../../lib/peopleApi";
import { describeErrorForUser } from "../../lib/userFacingError";
import { Field, Panel, Segmented, fieldClassName } from "./PeopleControls";
import { fillTemplate, formatDate } from "./peopleModel";

const USE_CHOICES = [1, 3, 5, 10] as const;
const EXPIRY_CHOICES = [1, 7, 30, null] as const;

const STATE_KEYS: Record<InviteState, TranslationKey> = {
  open: "people.invite.state.open",
  used: "people.invite.state.used",
  expired: "people.invite.state.expired",
  revoked: "people.invite.state.revoked",
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_600);
        });
      }}
      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-3.5 text-sm font-bold text-white transition-colors hover:bg-white/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {copied ? t("people.invite.copied") : label}
    </button>
  );
}

function inviteLink(code: string): string {
  return `${window.location.origin}/signup?invite=${encodeURIComponent(code)}`;
}

/** What an open invite shows when it is opened: its code, its link, revoking. */
function InviteDetail({
  invite,
  revoking,
  onRevoke,
}: {
  invite: Invite;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const { t } = useLanguage();
  const revokeButton = (
    <button
      type="button"
      disabled={revoking}
      onClick={onRevoke}
      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-rose-300/30 bg-white/[0.06] px-3.5 text-sm font-bold text-rose-100 transition-colors hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60 disabled:opacity-40"
    >
      {revoking ? (
        <Loader2 size={15} className="animate-spin" />
      ) : (
        <X size={15} />
      )}
      {t("people.invite.revoke")}
    </button>
  );

  if (!invite.code) {
    return (
      <div className="space-y-3 pb-4 pl-6">
        <p className="text-sm font-medium leading-6 text-white/65">
          {t("people.invite.codeNotKept")}
        </p>
        {revokeButton}
      </div>
    );
  }

  const link = inviteLink(invite.code);
  return (
    <div className="space-y-3 pb-4 pl-6">
      <p
        className="select-all break-all text-3xl font-black leading-none tracking-[0.08em] text-white tabular-nums"
        aria-label={invite.code.split("").join(" ")}
      >
        {invite.code}
      </p>
      <p className="select-all break-all text-xs font-medium leading-5 text-white/50">
        {link}
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        <CopyButton value={link} label={t("people.invite.copyLink")} />
        <CopyButton value={invite.code} label={t("people.invite.copyCode")} />
        {revokeButton}
      </div>
    </div>
  );
}

/**
 * Invite codes, the only way someone makes their own account. An open
 * invite opens to show its code and link for as long as it can admit anyone.
 */
export function InvitesSheet({
  invites,
  signupOpen,
  onChanged,
}: {
  invites: Invite[];
  signupOpen: boolean | null;
  onChanged: (invite: Invite) => void;
}) {
  const { t, language } = useLanguage();
  const reduceMotion = useReducedMotion();
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState<number>(1);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(7);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const make = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    setMade(false);
    try {
      const created = await createInvite({
        ...(label.trim() ? { label: label.trim() } : {}),
        maxUses,
        expiresInDays,
      });
      setLabel("");
      onChanged(created);
      // The new code opens in the list, where it can be read again later.
      setOpenId(created.id);
      setMade(true);
    } catch (failure) {
      setError(describeErrorForUser(failure, t));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    setRevoking(id);
    setError(null);
    try {
      onChanged(await revokeInvite(id));
      setOpenId(null);
    } catch (failure) {
      setError(describeErrorForUser(failure, t));
    } finally {
      setRevoking(null);
    }
  };

  const open = invites.filter((invite) => invite.state === "open");
  const past = invites.filter((invite) => invite.state !== "open");

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-5 pt-2">
        <span
          aria-hidden
          className="flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center rounded-full border border-dashed border-white/25 text-white/70"
        >
          <Ticket size={28} />
        </span>
        <div className="min-w-0">
          <h2 className="text-3xl font-black leading-tight text-white sm:text-4xl">
            {t("people.invites")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm font-semibold text-white/55">
            {t("people.invite.lead")}
          </p>
        </div>
      </header>

      {signupOpen === false ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-2xl border border-amber-300/25 px-4 py-3 text-sm font-semibold text-amber-100"
        >
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          {t("people.invite.signupClosed")}
        </p>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Panel title={t("people.invite.make")}>
          <form onSubmit={make} className="divide-y divide-white/[0.07]">
            <Field
              htmlFor="invite-label"
              label={t("people.invite.label")}
              hint={t("people.invite.labelHint")}
            >
              <input
                id="invite-label"
                value={label}
                maxLength={100}
                autoComplete="off"
                placeholder={t("people.invite.labelPlaceholder")}
                onChange={(event) => setLabel(event.target.value)}
                className={fieldClassName}
              />
            </Field>
            <div className="py-3.5">
              <p className="mb-2 text-[0.6875rem] font-black uppercase tracking-[0.12em] text-white/55">
                {t("people.invite.uses")}
              </p>
              <Segmented
                label={t("people.invite.uses")}
                value={maxUses}
                options={USE_CHOICES.map((value) => ({
                  value,
                  label:
                    value === 1
                      ? t("people.invite.oneUse")
                      : fillTemplate(t("people.invite.nUses"), {
                          count: value,
                        }),
                }))}
                onChange={setMaxUses}
              />
            </div>
            <div className="py-3.5">
              <p className="mb-2 text-[0.6875rem] font-black uppercase tracking-[0.12em] text-white/55">
                {t("people.invite.expires")}
              </p>
              <Segmented
                label={t("people.invite.expires")}
                value={expiresInDays}
                options={EXPIRY_CHOICES.map((value) => ({
                  value,
                  label:
                    value === null
                      ? t("people.invite.never")
                      : value === 1
                        ? t("people.invite.oneDay")
                        : fillTemplate(t("people.invite.nDays"), {
                            count: value,
                          }),
                }))}
                onChange={setExpiresInDays}
              />
            </div>
            <div className="py-4">
              <button
                type="submit"
                disabled={creating}
                className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[var(--accent)] px-4 text-sm font-bold text-zinc-950 transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-wait disabled:opacity-60"
              >
                {creating ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Ticket size={16} />
                )}
                {t("people.invite.create")}
              </button>
              {made ? (
                <p
                  role="status"
                  className="mt-3 flex items-center gap-2 text-sm font-bold text-emerald-300"
                >
                  <CircleCheck size={16} />
                  {t("people.invite.made")}
                </p>
              ) : null}
              {error ? (
                <p
                  role="alert"
                  className="mt-3 text-sm font-bold text-rose-200"
                >
                  {error}
                </p>
              ) : null}
            </div>
          </form>
        </Panel>

        <Panel
          title={t("people.invite.list")}
          aside={
            <span className="text-xs font-bold tabular-nums text-white/50">
              {fillTemplate(t("people.invitesOpen"), { count: open.length })}
            </span>
          }
        >
          {invites.length === 0 ? (
            <p className="py-6 text-sm font-semibold text-white/50">
              {t("people.invite.empty")}
            </p>
          ) : (
            <ul className="divide-y divide-white/[0.07]">
              {[...open, ...past].map((invite) => {
                const isOpen = invite.state === "open";
                const expanded = isOpen && openId === invite.id;
                const summary = (
                  <>
                    <span
                      aria-hidden
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        isOpen ? "bg-emerald-400" : "bg-white/25"
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-white/90">
                        {invite.label ?? t("people.invite.unlabelled")}
                      </span>
                      <span className="mt-0.5 block text-xs font-semibold tabular-nums text-white/50">
                        {t(STATE_KEYS[invite.state])}
                        <span aria-hidden className="mx-1.5 text-white/25">
                          ·
                        </span>
                        {fillTemplate(t("people.invite.usedOf"), {
                          used: invite.useCount,
                          max: invite.maxUses,
                        })}
                        <span aria-hidden className="mx-1.5 text-white/25">
                          ·
                        </span>
                        {invite.expiresAt
                          ? fillTemplate(
                              invite.state === "expired"
                                ? t("people.invite.expiredOn")
                                : t("people.invite.expiresOn"),
                              {
                                date: formatDate(invite.expiresAt, language),
                              },
                            )
                          : t("people.invite.noExpiry")}
                      </span>
                    </span>
                  </>
                );
                return (
                  <li key={invite.id}>
                    {isOpen ? (
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={`invite-${invite.id}`}
                        onClick={() => setOpenId(expanded ? null : invite.id)}
                        className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-4 rounded-lg px-2 py-3 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        {summary}
                        <span className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-white/55 group-hover:text-white">
                          {expanded
                            ? t("people.invite.hide")
                            : t("people.invite.show")}
                          <ChevronDown
                            size={15}
                            className={`transition-transform duration-200 motion-reduce:transition-none ${
                              expanded ? "rotate-180" : ""
                            }`}
                          />
                        </span>
                      </button>
                    ) : (
                      <div className="flex items-center gap-4 py-3 opacity-55">
                        {summary}
                      </div>
                    )}
                    <AnimatePresence initial={false}>
                      {expanded ? (
                        <motion.div
                          key="detail"
                          id={`invite-${invite.id}`}
                          initial={
                            reduceMotion
                              ? { opacity: 0 }
                              : { opacity: 0, height: 0 }
                          }
                          animate={{
                            opacity: 1,
                            height: "auto",
                            transition: { duration: 0.2 },
                          }}
                          exit={{
                            opacity: 0,
                            height: 0,
                            transition: { duration: 0.14 },
                          }}
                          className="overflow-hidden"
                        >
                          <InviteDetail
                            invite={invite}
                            revoking={revoking === invite.id}
                            onRevoke={() => void revoke(invite.id)}
                          />
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
