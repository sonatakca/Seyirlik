import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cog,
  Database,
  Film,
  HardDrive,
  HelpCircle,
  RefreshCw,
  Server,
  ServerCrash,
  XCircle,
} from "lucide-react";
import { Link } from "react-router-dom";
import { ArrowDownToLine, Bell } from "lucide-react";
import { isAdministrator } from "../lib/authStorage";
import { LoadingSpinner } from "./LoadingSpinner";
import { listOfflineTitles } from "../lib/offline/offlineLibrary";
import { useLanguage } from "../i18n/LanguageContext";
import type { ServerUnavailableEventDetail } from "../lib/mediaApi";
import {
  diagnoseServerConnection,
  type HealthChecks,
  type ServerConnectionDiagnosis,
  type ServerConnectionProblem,
} from "../lib/serverConnectionDiagnostics";

interface ServerConnectionErrorPageProps {
  failure?: ServerUnavailableEventDetail | null;
  onRetrySuccess: () => void;
  diagnoseConnection?: typeof diagnoseServerConnection;
  /** Retry action. Resolving means the server is usable again. */
  testConnection?: () => Promise<unknown>;
}

type DiagnosticState =
  | { status: "checking" }
  | { status: "ready"; diagnosis: ServerConnectionDiagnosis }
  | { status: "failed"; message: string };

type ServiceState = "online" | "offline" | "issue" | "unknown";

/**
 * Copy lives here rather than in the translation bundle on purpose: this page
 * is what the user sees when the app is failing, and it must not depend on
 * anything more than it has to.
 */
const COPY = {
  en: {
    checkingTitle: "Checking the server",
    eyebrow: "Server Connection",
    retry: "Retry",
    retrying: "Checking",
    seyirlikServer: "Seyirlik Server",
    online: "Running",
    offline: "Not running",
    issue: "Needs attention",
    unknown: "Unknown",
    dependencies: {
      database: "Database",
      jobs: "Background jobs",
      ffmpeg: "FFmpeg",
      ffprobe: "ffprobe",
      mediaStorage: "Media storage",
      generatedStorage: "Generated storage",
    } satisfies Record<keyof HealthChecks, string>,
    problems: {
      none: {
        title: "The server is reachable.",
        detail: "Retrying should get you back in.",
      },
      unreachable: {
        title: "The server did not answer.",
        detail:
          "Nothing responded at this address. The server may be stopped, or this device may be offline.",
      },
      "proxy-error": {
        title: "The reverse proxy cannot reach Seyirlik.",
        detail:
          "Something in front of the server answered, but it could not pass the request through. The proxy is running; Seyirlik behind it may not be.",
      },
      "not-alive": {
        title: "Seyirlik is running, but reports it is not healthy.",
        detail: "The server answered and said it cannot serve requests yet.",
      },
      "dependency-unavailable": {
        title: "Seyirlik is missing something it needs.",
        detail: "The server is running, but a dependency below is unavailable.",
      },
      "starting-up": {
        title: "Seyirlik is still starting up.",
        detail: "The server is alive and finishing its startup work.",
      },
      "unexpected-response": {
        title: "Something answered, but it was not Seyirlik.",
        detail:
          "The address returned a response the app did not recognise. A captive portal or a misconfigured proxy usually causes this.",
      },
      unknown: {
        title: "The server could not be reached.",
        detail: "The reason was not something the app could identify.",
      },
    } satisfies Record<
      ServerConnectionProblem,
      { title: string; detail: string }
    >,
    referenceLabel: "Reference",
  },
  tr: {
    checkingTitle: "Sunucu kontrol ediliyor",
    eyebrow: "Sunucu Bağlantısı",
    retry: "Tekrar dene",
    retrying: "Kontrol ediliyor",
    seyirlikServer: "Seyirlik Sunucusu",
    online: "Çalışıyor",
    offline: "Çalışmıyor",
    issue: "İlgilenilmeli",
    unknown: "Bilinmiyor",
    dependencies: {
      database: "Veritabanı",
      jobs: "Arka plan işleri",
      ffmpeg: "FFmpeg",
      ffprobe: "ffprobe",
      mediaStorage: "Medya deposu",
      generatedStorage: "Üretilen dosya deposu",
    } satisfies Record<keyof HealthChecks, string>,
    problems: {
      none: {
        title: "Sunucuya ulaşılabiliyor.",
        detail: "Tekrar denemek yeterli olacaktır.",
      },
      unreachable: {
        title: "Sunucu yanıt vermedi.",
        detail:
          "Bu adreste hiçbir yanıt alınamadı. Sunucu durmuş olabilir veya bu cihaz çevrimdışı olabilir.",
      },
      "proxy-error": {
        title: "Ters vekil sunucu Seyirlik'e ulaşamıyor.",
        detail:
          "Sunucunun önündeki bir katman yanıt verdi ama isteği iletemedi. Vekil sunucu çalışıyor; arkasındaki Seyirlik çalışmıyor olabilir.",
      },
      "not-alive": {
        title: "Seyirlik çalışıyor ama sağlıklı olmadığını bildiriyor.",
        detail:
          "Sunucu yanıt verdi ve henüz istekleri karşılayamadığını söyledi.",
      },
      "dependency-unavailable": {
        title: "Seyirlik'in ihtiyaç duyduğu bir bileşen eksik.",
        detail:
          "Sunucu çalışıyor ancak aşağıdaki bileşenlerden biri kullanılamıyor.",
      },
      "starting-up": {
        title: "Seyirlik hâlâ başlatılıyor.",
        detail: "Sunucu çalışıyor ve başlangıç işlerini tamamlıyor.",
      },
      "unexpected-response": {
        title: "Bir yanıt geldi ama Seyirlik'ten değil.",
        detail:
          "Adres, uygulamanın tanımadığı bir yanıt döndürdü. Genellikle bir ağ giriş sayfası veya yanlış yapılandırılmış vekil sunucu buna yol açar.",
      },
      unknown: {
        title: "Sunucuya ulaşılamadı.",
        detail: "Nedeni uygulama tarafından belirlenemedi.",
      },
    } satisfies Record<
      ServerConnectionProblem,
      { title: string; detail: string }
    >,
    referenceLabel: "Referans",
  },
};

const DEPENDENCY_ICONS: Record<keyof HealthChecks, typeof Server> = {
  database: Database,
  jobs: Cog,
  ffmpeg: Film,
  ffprobe: Film,
  mediaStorage: HardDrive,
  generatedStorage: HardDrive,
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusStyles(status: ServiceState): {
  icon: typeof CheckCircle2;
  className: string;
} {
  switch (status) {
    case "online":
      return {
        icon: CheckCircle2,
        className: "border-emerald-300/25 bg-emerald-300/10 text-emerald-100",
      };
    case "offline":
      return {
        icon: XCircle,
        className: "border-rose-300/25 bg-rose-300/10 text-rose-100",
      };
    case "issue":
      return {
        icon: AlertTriangle,
        className: "border-amber-300/25 bg-amber-300/10 text-amber-100",
      };
    case "unknown":
      return {
        icon: HelpCircle,
        className: "border-white/15 bg-white/[0.07] text-white/78",
      };
  }
}

function ServiceStatusCard({
  icon: Icon,
  title,
  status,
  statusLabel,
  detail,
}: {
  icon: typeof Server;
  title: string;
  status: ServiceState;
  statusLabel: string;
  detail: string;
}) {
  const styles = statusStyles(status);
  const StatusIcon = styles.icon;

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.055] p-5 shadow-floating-panel">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/30 text-white/86">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-black text-white">{title}</h2>
            {detail ? (
              <p className="mt-1 break-words text-sm leading-6 text-white/58">
                {detail}
              </p>
            ) : null}
          </div>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-black ${styles.className}`}
        >
          <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {statusLabel}
        </span>
      </div>
    </section>
  );
}

function LoadingView({ label }: { label: string }) {
  return (
    <main
      className="flex min-h-screen items-center justify-center px-6 transition-opacity duration-300 ease-in-out"
      aria-busy="true"
      aria-label={label}
    >
      <div className="text-center">
        <LoadingSpinner label="" />
      </div>
    </main>
  );
}

function getServerState(problem: ServerConnectionProblem): ServiceState {
  switch (problem) {
    case "none":
      return "online";
    case "unreachable":
    case "proxy-error":
    case "not-alive":
      return "offline";
    case "dependency-unavailable":
    case "starting-up":
      return "issue";
    case "unexpected-response":
    case "unknown":
      return "unknown";
  }
}

export function ServerConnectionErrorPage({
  failure,
  onRetrySuccess,
  diagnoseConnection = diagnoseServerConnection,
  testConnection,
}: ServerConnectionErrorPageProps) {
  const [hasDownloads, setHasDownloads] = useState(false);
  useEffect(() => {
    let current = true;
    void listOfflineTitles()
      .then((titles) => {
        if (current) {
          setHasDownloads(titles.some((title) => title.state === "complete"));
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  const { language, t } = useLanguage();
  const copy = COPY[language];
  const [state, setState] = useState<DiagnosticState>({ status: "checking" });
  const [isRetrying, setIsRetrying] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      setIsVisible(true);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  const finishWithFadeOut = useCallback(() => {
    setIsVisible(false);

    window.setTimeout(() => {
      onRetrySuccess();
    }, 300);
  }, [onRetrySuccess]);

  const runDiagnostics = useCallback(async () => {
    setState({ status: "checking" });

    try {
      const diagnosis = await diagnoseConnection({ failure });

      if (diagnosis.problem === "none") {
        finishWithFadeOut();
        return;
      }

      setState({ status: "ready", diagnosis });
    } catch (error) {
      setState({ status: "failed", message: getErrorMessage(error) });
    }
  }, [diagnoseConnection, failure, finishWithFadeOut]);

  useEffect(() => {
    void runDiagnostics();
  }, [runDiagnostics]);

  const handleRetry = useCallback(async () => {
    setIsRetrying(true);

    try {
      if (testConnection) {
        await testConnection();
        finishWithFadeOut();
        return;
      }

      await runDiagnostics();
    } catch {
      await runDiagnostics();
    } finally {
      setIsRetrying(false);
    }
  }, [finishWithFadeOut, runDiagnostics, testConnection]);

  const fallbackDiagnosis = useMemo<ServerConnectionDiagnosis | null>(() => {
    if (state.status !== "failed") {
      return null;
    }

    return {
      problem: "unknown",
      checkedAt: new Date().toISOString(),
      probe: {
        endpoint: "/ownAPI/v1/health",
        kind: "network-error",
        reachable: false,
        alive: false,
        ready: false,
        message: state.message,
      },
      failedDependencies: [],
    };
  }, [state]);

  if (state.status === "checking") {
    return <LoadingView label={copy.checkingTitle} />;
  }

  const diagnosis =
    state.status === "ready" ? state.diagnosis : fallbackDiagnosis;

  if (!diagnosis) {
    return <LoadingView label={copy.checkingTitle} />;
  }

  const serverState = getServerState(diagnosis.problem);
  const problemCopy = copy.problems[diagnosis.problem];
  const { requestId } = diagnosis.probe;

  return (
    <main className="min-h-screen bg-[#050505] px-5 py-10 text-white sm:px-8 lg:px-12">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-6xl items-center">
        <div className="w-full">
          <div
            className={`mb-8 flex justify-center transition-all duration-500 ease-out ${
              isVisible
                ? "translate-y-0 opacity-100 delay-75"
                : "translate-y-3 opacity-0 delay-0"
            }`}
          >
            <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.06] px-5 py-3 text-md font-black uppercase tracking-[0.18em] text-white/62">
              <AlertTriangle className="h-6 w-6 text-amber-200" />
              {copy.eyebrow}
            </div>
          </div>

          <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-5">
            {/*
              Assertive rather than polite: the page has replaced the whole
              interface, so this is the only thing left to announce.
            */}
            <div
              role="alert"
              aria-live="assertive"
              className={`w-full text-center transition-all duration-500 ease-out ${
                isVisible
                  ? "translate-y-0 opacity-100 delay-150"
                  : "translate-y-4 opacity-0 delay-0"
              }`}
            >
              <h1 className="text-xl font-black text-white sm:text-2xl">
                {problemCopy.title}
              </h1>
              <p className="mt-2 text-sm leading-6 text-white/62">
                {problemCopy.detail}
              </p>
            </div>

            <aside
              className={`grid w-full gap-3 transition-all duration-500 ease-out ${
                isVisible
                  ? "translate-y-0 opacity-100 delay-200"
                  : "translate-y-4 opacity-0 delay-0"
              }`}
            >
              <ServiceStatusCard
                icon={serverState === "online" ? Server : ServerCrash}
                title={copy.seyirlikServer}
                status={serverState}
                statusLabel={copy[serverState]}
                detail=""
              />

              {/*
                Only the dependencies that are actually failing. A healthy list
                of six is noise on a page whose whole job is to name the one
                thing that is wrong.
              */}
              {diagnosis.failedDependencies.map((name) => (
                <ServiceStatusCard
                  key={name}
                  icon={DEPENDENCY_ICONS[name]}
                  title={copy.dependencies[name]}
                  status="offline"
                  statusLabel={copy.offline}
                  detail=""
                />
              ))}
            </aside>

            <div
              className={`flex w-full max-w-sm items-center gap-2.5 transition-all duration-500 ease-out ${
                isVisible
                  ? "translate-y-0 opacity-100 delay-[350ms]"
                  : "translate-y-4 opacity-0 delay-0"
              }`}
            >
              <button
                type="button"
                onClick={() => void handleRetry()}
                disabled={isRetrying}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-white px-5 text-sm font-black text-zinc-950 shadow-button-glow transition hover:bg-white/86 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-wait disabled:opacity-70"
              >
                <RefreshCw
                  className={`h-4 w-4 ${isRetrying ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {isRetrying ? copy.retrying : copy.retry}
              </button>
            </div>

            {isAdministrator() ? (
              <Link
                to="/alerts"
                className="inline-flex min-h-11 w-full max-w-sm items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/[0.06] px-5 text-sm font-black text-white transition hover:bg-white/[0.12] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              >
                <Bell className="h-4 w-4" aria-hidden="true" />
                {t("alerts.open")}
              </Link>
            ) : null}

            {/* Being without the server is exactly when a download is for. */}
            {hasDownloads ? (
              <Link
                to="/downloads"
                className="inline-flex min-h-11 w-full max-w-sm items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/[0.06] px-5 text-sm font-black text-white transition hover:bg-white/[0.12] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              >
                <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
                {t("downloads.watchDownloads")}
              </Link>
            ) : null}

            {/*
              The request id is the only thing that ties this failure to a line
              in the server log. It carries no information about the server.
            */}
            {requestId ? (
              <p className="text-center text-xs font-semibold text-white/35">
                {copy.referenceLabel}:{" "}
                <code className="font-mono text-white/50">{requestId}</code>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
