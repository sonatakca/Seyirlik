import { useCallback, useEffect, useState } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  clearOpenSubtitlesAccount,
  clearOpenSubtitlesApiKey,
  getOpenSubtitlesStatus,
  saveOpenSubtitlesAccount,
  saveOpenSubtitlesApiKey,
  type OpenSubtitlesStatus,
} from "../../lib/subtitlesApi";

const CONSUMERS = "https://www.opensubtitles.com/en/consumers";

const STATE_STYLE: Record<string, string> = {
  active: "text-emerald-300",
  rejected: "text-amber-200",
  "signed-out": "text-white/45",
};

const INPUT =
  "min-h-9 rounded-lg border border-white/15 bg-black/40 px-3 font-mono text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const SUBMIT =
  "min-h-9 rounded-lg bg-[var(--accent)] px-4 text-sm font-black text-black disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";
const QUIET =
  "rounded-full px-3 py-1.5 text-xs font-bold text-white/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

/** What the server's error code means, in the reader's language. */
function failureKey(error: unknown): TranslationKey {
  const { status, code } = error as { status?: number; code?: string };
  if (code === "OPENSUBTITLES_SIGN_IN_REFUSED")
    return "admin.integrations.opensubtitles.refused";
  if (code === "OPENSUBTITLES_KEY_REFUSED")
    return "admin.integrations.opensubtitles.keyRefused";
  if (code === "OPENSUBTITLES_KEY_MISSING")
    return "admin.integrations.opensubtitles.keyFirst";
  if (status === 400) return "admin.integrations.opensubtitles.invalid";
  return "admin.integrations.opensubtitles.unreachable";
}

/**
 * OpenSubtitles' API key and the accounts that download.
 *
 * It is asked only when TürkçeAltyazı has nothing, and its downloads are
 * counted per account per day, so a person can sign in two accounts: the
 * first downloads until its day is used up, then the second takes over. The
 * key and passwords are write-only — the server seals them and only ever says
 * which account is signed in — so every form here starts empty.
 */
export function OpenSubtitlesAccounts() {
  const { t } = useLanguage();
  const [status, setStatus] = useState<OpenSubtitlesStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [openSlot, setOpenSlot] = useState<number | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getOpenSubtitlesStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getOpenSubtitlesStatus()
      .then((value) => !cancelled && setStatus(value))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function act(operation: () => Promise<string | null>) {
    setWorking(true);
    setMessage(null);
    try {
      const text = await operation();
      if (text) setMessage({ tone: "ok", text });
      await load();
    } catch (error) {
      setMessage({ tone: "error", text: t(failureKey(error)) });
    } finally {
      setWorking(false);
    }
  }

  if (!status) return null;
  const keySaved = status.apiKey.state === "active";

  return (
    <div className="mt-3 space-y-3">
      <p className="text-xs font-medium text-white/55">
        {t("admin.integrations.opensubtitles.description")}
      </p>
      {message ? (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={`text-xs font-bold ${message.tone === "error" ? "text-red-200" : "text-emerald-200"}`}
        >
          {message.text}
        </p>
      ) : null}

      <form
        className="space-y-2 rounded-xl border border-white/10 px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await saveOpenSubtitlesApiKey(apiKey);
            setApiKey("");
            return t("admin.integrations.opensubtitles.keySaved");
          });
        }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="text-xs font-black text-white/80">
            {t("admin.integrations.opensubtitles.apiKey")}
          </span>
          <span
            className={`text-xs font-black ${keySaved ? "text-emerald-300" : "text-white/45"}`}
          >
            {t(
              keySaved
                ? "admin.integrations.opensubtitles.keyActive"
                : "admin.integrations.opensubtitles.keyMissing",
            )}
          </span>
        </div>
        <p className="text-xs font-medium text-white/45">
          {t("admin.integrations.opensubtitles.apiKeyHint")}{" "}
          <a
            href={CONSUMERS}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 underline"
          >
            opensubtitles.com
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={t("admin.integrations.opensubtitles.apiKey")}
            className={`${INPUT} w-full min-w-0 sm:w-auto sm:flex-1`}
          />
          <button
            type="submit"
            disabled={working || !apiKey.trim()}
            className={SUBMIT}
          >
            {t("admin.integrations.opensubtitles.saveKey")}
          </button>
          {keySaved ? (
            <button
              type="button"
              disabled={working}
              onClick={() =>
                void act(async () => {
                  await clearOpenSubtitlesApiKey();
                  return null;
                })
              }
              className={QUIET}
            >
              {t("admin.integrations.opensubtitles.removeKey")}
            </button>
          ) : null}
        </div>
      </form>

      <ul className="space-y-2">
        {status.accounts.map((account) => {
          const renews = /renew at (\S+?)\.?$/.exec(account.reason ?? "")?.[1];
          return (
            <li
              key={account.slot}
              className="rounded-xl border border-white/10 px-3 py-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-xs font-black text-white/80">
                  {t("admin.integrations.opensubtitles.account")} {account.slot}
                  {account.username ? (
                    <span className="ml-2 font-mono font-medium text-white/55">
                      {account.username}
                    </span>
                  ) : null}
                </span>
                <span
                  className={`text-xs font-black ${STATE_STYLE[account.state]}`}
                >
                  {t(
                    `admin.integrations.session.state.${account.state}` as TranslationKey,
                  )}
                </span>
              </div>
              {renews ? (
                <p className="mt-1 text-xs text-amber-100/70">
                  {t("admin.integrations.opensubtitles.quotaUsed")}{" "}
                  {new Date(renews).toLocaleString()}
                </p>
              ) : account.reason ? (
                <p className="mt-1 text-xs text-amber-100/70">
                  {account.reason}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!keySaved}
                  onClick={() => {
                    setOpenSlot(
                      openSlot === account.slot ? null : account.slot,
                    );
                    setUsername("");
                    setPassword("");
                  }}
                  aria-expanded={openSlot === account.slot}
                  className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.08] px-3 py-1.5 text-xs font-black text-white/85 hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <KeyRound size={13} aria-hidden="true" />
                  {t("admin.integrations.session.signIn")}
                </button>
                {account.state !== "signed-out" ? (
                  <button
                    type="button"
                    disabled={working}
                    onClick={() =>
                      void act(async () => {
                        await clearOpenSubtitlesAccount(account.slot);
                        return null;
                      })
                    }
                    className={QUIET}
                  >
                    {t("admin.integrations.opensubtitles.signOut")}
                  </button>
                ) : null}
              </div>
              {openSlot === account.slot ? (
                <form
                  className="mt-3 space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                      const result = await saveOpenSubtitlesAccount(
                        account.slot,
                        { username, password },
                      );
                      setPassword("");
                      setOpenSlot(null);
                      return result.allowedDownloads !== null
                        ? `${t("admin.integrations.opensubtitles.signedIn")} ${result.allowedDownloads} ${t("admin.integrations.opensubtitles.perDay")}`
                        : t("admin.integrations.opensubtitles.signedIn");
                    });
                  }}
                >
                  <label className="flex flex-col gap-1 text-xs font-bold text-white/60">
                    {t("admin.integrations.opensubtitles.username")}
                    <input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      className={INPUT}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-bold text-white/60">
                    {t("admin.integrations.opensubtitles.password")}
                    <input
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      type="password"
                      autoComplete="new-password"
                      className={INPUT}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={working || !username.trim() || !password}
                    className={SUBMIT}
                  >
                    {t("admin.integrations.session.signIn")}
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
