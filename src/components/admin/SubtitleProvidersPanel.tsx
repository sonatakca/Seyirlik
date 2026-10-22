import { useCallback, useEffect, useState } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  clearProviderSession,
  listSubtitleProviders,
  saveProviderSession,
  type SubtitleProviderStatus,
} from "../../lib/subtitlesApi";
import { OpenSubtitlesAccounts } from "./OpenSubtitlesAccounts";

const PROVIDER_SITES: Record<string, string> = {
  turkcealtyazi: "https://turkcealtyazi.org/",
};

const STATE_STYLE: Record<string, string> = {
  anonymous: "text-emerald-300",
  active: "text-emerald-300",
  rejected: "text-amber-200",
  "signed-out": "text-white/45",
};

/**
 * Signing a subtitle provider in.
 *
 * TürkçeAltyazı trusts a browser that passed its Cloudflare check, so the
 * person does that in this browser and hands over the resulting Cookie header.
 * This browser's user agent goes with it, because the site only honours the
 * cookie from the browser that earned it. The value is write-only: the server
 * seals it and never sends it back, so this form starts empty every time.
 */
export function SubtitleProvidersPanel() {
  const { t } = useLanguage();
  const [providers, setProviders] = useState<SubtitleProviderStatus[] | null>(
    null,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [cookie, setCookie] = useState("");
  const [userAgent, setUserAgent] = useState(
    typeof navigator === "undefined" ? "" : navigator.userAgent,
  );
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setProviders(await listSubtitleProviders());
    } catch {
      // 404 when subtitles are not configured; the list above already says so.
      setProviders([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    listSubtitleProviders()
      .then((rows) => !cancelled && setProviders(rows))
      .catch(() => !cancelled && setProviders([]));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!providers || providers.length === 0) return null;

  async function save(providerId: string) {
    setWorking(true);
    setMessage(null);
    try {
      const result = await saveProviderSession(providerId, {
        cookie,
        userAgent,
      });
      setCookie("");
      setOpenId(null);
      setMessage({
        tone: "ok",
        text: `${t("admin.integrations.session.saved")} ${result.resumed}`,
      });
      await load();
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          (error as { status?: number }).status === 400
            ? t("admin.integrations.session.invalid")
            : t("admin.integrations.session.failed"),
      });
    } finally {
      setWorking(false);
    }
  }

  async function forget(providerId: string) {
    setWorking(true);
    try {
      await clearProviderSession(providerId);
      await load();
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-5">
      <h2 className="text-lg font-black text-white">
        {t("admin.integrations.session.title")}
      </h2>
      <p className="mt-1 text-sm font-semibold text-white/50">
        {t("admin.integrations.session.description")}
      </p>
      {message ? (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={`mt-3 text-sm font-bold ${message.tone === "error" ? "text-red-200" : "text-emerald-200"}`}
        >
          {message.text}
        </p>
      ) : null}
      <ul className="mt-3 space-y-2">
        {providers.map((provider) => {
          const state = provider.session?.state ?? "anonymous";
          const site = PROVIDER_SITES[provider.id];
          return (
            <li
              key={provider.id}
              className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-sm font-bold text-white/85">
                  {provider.label}
                  {provider.languages ? (
                    <span className="ml-2 text-xs font-medium text-white/40">
                      {provider.languages.join(", ").toUpperCase()}
                    </span>
                  ) : null}
                </span>
                {provider.requiresSession ? (
                  <span className={`text-sm font-black ${STATE_STYLE[state]}`}>
                    {t(
                      `admin.integrations.session.state.${state}` as TranslationKey,
                    )}
                  </span>
                ) : null}
              </div>
              {provider.session?.state === "rejected" &&
              provider.session.reason ? (
                <p className="mt-1 text-xs text-amber-100/70">
                  {provider.session.reason}
                </p>
              ) : null}
              {provider.id === "opensubtitles" ? (
                <OpenSubtitlesAccounts />
              ) : null}
              {provider.session?.updatedAt ? (
                <p className="mt-1 text-xs text-white/40">
                  {t("admin.integrations.session.updated")}{" "}
                  {new Date(provider.session.updatedAt).toLocaleString()}
                </p>
              ) : null}
              {provider.requiresSession ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setOpenId(openId === provider.id ? null : provider.id)
                    }
                    aria-expanded={openId === provider.id}
                    className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.08] px-3 py-1.5 text-xs font-black text-white/85 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    <KeyRound size={13} aria-hidden="true" />
                    {t("admin.integrations.session.signIn")}
                  </button>
                  {state === "active" || state === "rejected" ? (
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => void forget(provider.id)}
                      className="rounded-full px-3 py-1.5 text-xs font-bold text-white/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      {t("admin.integrations.session.forget")}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {openId === provider.id ? (
                <form
                  className="mt-4 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(provider.id);
                  }}
                >
                  <ol className="list-decimal space-y-1 pl-5 text-xs font-medium text-white/65">
                    <li>
                      {t("admin.integrations.session.step1")}{" "}
                      {site ? (
                        <a
                          href={site}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 underline"
                        >
                          {new URL(site).host}
                          <ExternalLink size={11} aria-hidden="true" />
                        </a>
                      ) : null}
                    </li>
                    <li>{t("admin.integrations.session.step2")}</li>
                    <li>{t("admin.integrations.session.step3")}</li>
                  </ol>
                  <label className="flex flex-col gap-1 text-xs font-bold text-white/60">
                    {t("admin.integrations.session.cookie")}
                    <textarea
                      value={cookie}
                      onChange={(event) => setCookie(event.target.value)}
                      rows={3}
                      autoComplete="off"
                      spellCheck={false}
                      className="rounded-lg border border-white/15 bg-black/40 px-3 py-2 font-mono text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-bold text-white/60">
                    {t("admin.integrations.session.userAgent")}
                    <input
                      value={userAgent}
                      onChange={(event) => setUserAgent(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      className="min-h-9 rounded-lg border border-white/15 bg-black/40 px-3 font-mono text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    />
                    <span className="font-medium text-white/40">
                      {t("admin.integrations.session.userAgentHint")}
                    </span>
                  </label>
                  <button
                    type="submit"
                    disabled={working || !cookie.trim() || !userAgent.trim()}
                    className="min-h-9 rounded-lg bg-[var(--accent)] px-4 text-sm font-black text-black disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  >
                    {t("admin.integrations.session.save")}
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
