import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, CircleAlert, Send } from "lucide-react";
import { BackButton } from "../components/BackButton";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";
import { isAdministrator } from "../lib/authStorage";
import {
  currentPushSubscription,
  disablePush,
  enablePush,
  fetchAlerts,
  loadAlertCredentials,
  pushSupported,
  refreshAlertCredentials,
  sendTestAlert,
  type AlertCredentials,
  type AlertEntry,
  type AlertsSnapshot,
} from "../lib/alerts/alertsClient";
import { setPageTitle } from "../lib/pageTitle";

const ACTION =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full border border-white/12 bg-white/[0.06] px-4 text-sm font-bold text-white transition-colors duration-200 hover:border-white/25 hover:bg-white/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-wait disabled:opacity-60";

const SEVERITY_DOT: Record<AlertEntry["severity"], string> = {
  critical: "bg-red-400",
  warning: "bg-amber-300",
  info: "bg-emerald-300",
};

function useRelativeTime(language: string) {
  return useCallback(
    (at: number | null) => {
      if (at === null) return "—";
      const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
      const minutes = Math.round((at - Date.now()) / 60_000);
      if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
      const hours = Math.round(minutes / 60);
      if (Math.abs(hours) < 48) return format.format(hours, "hour");
      return format.format(Math.round(hours / 24), "day");
    },
    [language],
  );
}

const STORAGE_LABELS: Record<string, TranslationKey> = {
  healthy: "alerts.storageState.healthy",
  unavailable: "alerts.storageState.unavailable",
  suspect: "alerts.storageState.suspect",
  quarantined: "alerts.storageState.quarantined",
  "recovery-pending": "alerts.storageState.recoveryPending",
};

function storageLabel(
  state: string | null,
  t: (key: TranslationKey) => string,
): string {
  if (!state) return "—";
  const key = STORAGE_LABELS[state];
  return key ? t(key) : state;
}

/**
 * What the alert service has seen, readable when the server is not.
 *
 * Routed outside the server check, like Downloads: the moment somebody opens
 * this is usually the moment the server is down.
 */
export function AlertsPage() {
  const { t, language } = useLanguage();
  const relative = useRelativeTime(language);
  const [credentials, setCredentials] = useState<AlertCredentials | null>(null);
  const [snapshot, setSnapshot] = useState<AlertsSnapshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const load = useCallback(async (current: AlertCredentials) => {
    try {
      setSnapshot(await fetchAlerts(current));
      setProblem(null);
    } catch {
      setProblem("unreachable");
    }
  }, []);

  useEffect(() => {
    setPageTitle(t("alerts.title"), {
      canonicalPath: "/alerts",
      robots: "noindex, nofollow",
    });
    let cancelled = false;
    void (async () => {
      // A fresh token while the server can give one; the stored one otherwise.
      const stored = await loadAlertCredentials().catch(() => null);
      const fresh = await refreshAlertCredentials().catch(() => null);
      const current = fresh ?? stored;
      if (cancelled) return;
      if (!current) {
        setProblem("not-connected");
        return;
      }
      setCredentials(current);
      setIsSubscribed(
        Boolean(await currentPushSubscription().catch(() => null)),
      );
      await load(current);
    })();
    return () => {
      cancelled = true;
    };
  }, [load, t]);

  useEffect(() => {
    if (!credentials) return undefined;
    const timer = window.setInterval(() => void load(credentials), 30_000);
    return () => window.clearInterval(timer);
  }, [credentials, load]);

  if (!isAdministrator()) {
    return (
      <main className="mx-auto min-h-screen max-w-3xl px-4 pt-[calc(env(safe-area-inset-top)+1.5rem)] text-white sm:pt-12">
        <BackButton to="/home" label={t("common.home")} className="mb-8" />
        <p className="text-sm font-semibold text-white/60">
          {t("alerts.adminsOnly")}
        </p>
      </main>
    );
  }

  const host = snapshot?.host;
  const toggle = async () => {
    if (!credentials) return;
    setIsBusy(true);
    try {
      if (isSubscribed) {
        await disablePush(credentials);
        setIsSubscribed(false);
      } else {
        await enablePush(credentials);
        setIsSubscribed(true);
      }
      setProblem(null);
    } catch {
      setProblem("push");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 pb-24 pt-[calc(env(safe-area-inset-top)+1.5rem)] text-white sm:px-6 sm:pt-12">
      {/* No navbar here (the page must work while the server is down), and a
          notification opens it with no history behind it, so the way out is
          a named place rather than "back". */}
      <BackButton to="/home" label={t("common.home")} className="mb-8" />
      <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
        {t("alerts.title")}
      </h1>
      <p className="mt-2 max-w-xl text-sm font-medium leading-6 text-white/55">
        {t("alerts.description")}
      </p>

      {host ? (
        <section className="mt-8 grid gap-3 sm:grid-cols-3">
          <div className="rounded-3xl border border-white/10 bg-white/[0.045] p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-white/40">
              {t("alerts.server")}
            </p>
            <p
              className={`mt-2 flex items-center gap-2 text-lg font-black ${
                host.down ? "text-red-300" : "text-emerald-300"
              }`}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${host.down ? "bg-red-400" : "bg-emerald-300"}`}
              />
              {host.down ? t("alerts.down") : t("alerts.up")}
            </p>
            <p className="mt-1 text-xs font-semibold text-white/45">
              {t("alerts.lastHeartbeat").replace(
                "{time}",
                relative(host.lastHeartbeatAt),
              )}
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-white/[0.045] p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-white/40">
              {t("alerts.storage")}
            </p>
            <p className="mt-2 text-lg font-black">
              {storageLabel(host.storage, t)}
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-white/[0.045] p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-white/40">
              {t("alerts.lastBackup")}
            </p>
            <p className="mt-2 text-lg font-black">
              {relative(host.lastVerifiedBackupAt)}
            </p>
          </div>
        </section>
      ) : null}

      {credentials ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {pushSupported() ? (
            <button
              type="button"
              className={ACTION}
              disabled={isBusy}
              onClick={() => void toggle()}
            >
              {isSubscribed ? <BellOff size={16} /> : <Bell size={16} />}
              {isSubscribed ? t("alerts.pushOff") : t("alerts.pushOn")}
            </button>
          ) : null}
          <button
            type="button"
            className={ACTION}
            onClick={() =>
              void sendTestAlert(credentials)
                .then(() => load(credentials))
                .catch(() => setProblem("unreachable"))
            }
          >
            <Send size={16} />
            {t("alerts.test")}
          </button>
        </div>
      ) : null}

      {problem ? (
        <p className="mt-6 flex items-start gap-2 rounded-2xl border border-white/10 bg-white/[0.045] px-4 py-3 text-sm font-semibold text-white/70">
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          {problem === "not-connected"
            ? t("alerts.notConnected")
            : problem === "push"
              ? t("alerts.pushFailed")
              : t("alerts.unreachable")}
        </p>
      ) : null}

      {snapshot ? (
        snapshot.alerts.length === 0 ? (
          <p className="mt-10 text-sm font-semibold text-white/55">
            {t("alerts.empty")}
          </p>
        ) : (
          <ul className="mt-8 space-y-2">
            {snapshot.alerts.map((alert) => (
              <li
                key={alert.id}
                className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3"
              >
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[alert.severity]}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="text-sm font-black text-white">
                      {alert.title}
                    </p>
                    <p className="text-xs font-semibold text-white/40">
                      {relative(alert.createdAt)}
                    </p>
                  </div>
                  {alert.body ? (
                    <p className="mt-0.5 text-sm font-medium leading-6 text-white/60">
                      {alert.body}
                    </p>
                  ) : null}
                  {alert.key && alert.resolvedAt === null ? (
                    <p className="mt-1 text-xs font-bold uppercase tracking-[0.12em] text-red-300/80">
                      {t("alerts.ongoing")}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </main>
  );
}
