import { useCallback, useEffect, useState } from "react";
import { Lock, RefreshCw } from "lucide-react";
import { setPageTitle } from "../../lib/pageTitle";
import { useLanguage } from "../../i18n/LanguageContext";
import { WorkflowSteps } from "../../components/admin/WorkflowSteps";
import {
  expectedStrategy,
  readStorageGate,
  RECORDED_EXPANSION_EVIDENCE,
} from "../../lib/storageAuthorization";
import {
  listImports,
  reconcileImport,
  retryImport,
  type ImportRow,
} from "../../lib/importsApi";
import { DriveUploadPanel } from "./DriveUploadPanel";

/** How often the list is read again while a file is still uploading. */
const UPLOAD_REFRESH_MS = 5_000;

/**
 * What the importer has done, and whether it may do anything at all.
 *
 * The gate comes first on the page because it changes the meaning of
 * everything under it: with storage unauthorised the list is a record of what
 * would happen, not of what is happening. There is deliberately no control
 * that opens the gate — it is derived from whether the importer is configured
 * at all, so there is nothing here that could disagree with the server.
 */

/** Which imports are waiting for a person. */
const ATTENTION_STATES = ["needs_attention", "uncertain", "failed"];

export function ImportsPage() {
  const { t } = useLanguage();
  const [imports, setImports] = useState<ImportRow[] | null>(null);
  const [importsAvailable, setImportsAvailable] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setPageTitle(`${t("admin.imports.title")} · Seyirlik`, {
      canonicalPath: "/admin/imports",
      robots: "noindex, nofollow",
    });
  }, [t]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setFailure(null);
    try {
      setImports(await listImports());
      setNowMs(Date.now());
      setImportsAvailable(true);
    } catch (error) {
      /*
       * The routes are mounted only when a download root is configured, so a
       * "not found" is the answer to whether importing is set up rather than a
       * failure to report as one.
       */
      if ((error as { status?: number }).status === 404) {
        setImportsAvailable(false);
        setImports([]);
      } else {
        setFailure("admin.imports.loadFailed");
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let isCancelled = false;

    void (async () => {
      try {
        const rows = await listImports();
        if (!isCancelled) {
          setImports(rows);
          setImportsAvailable(true);
        }
      } catch (error) {
        if (isCancelled) return;
        if ((error as { status?: number }).status === 404) {
          setImportsAvailable(false);
          setImports([]);
        } else {
          setFailure("admin.imports.loadFailed");
        }
      } finally {
        if (!isCancelled) setIsLoading(false);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, []);

  /*
   * An upload moves on its own, so while one is under way the list is read
   * again quietly: no spinner, and a failed read keeps the last one.
   */
  const uploading = (imports ?? []).some(
    (row) => row.driveUpload?.state === "uploading",
  );
  useEffect(() => {
    if (!uploading) return;
    const timer = window.setInterval(() => {
      void listImports()
        .then((rows) => {
          setImports(rows);
          setNowMs(Date.now());
        })
        .catch(() => undefined);
    }, UPLOAD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [uploading]);

  const act = useCallback(
    async (id: string, action: "retry" | "reconcile") => {
      await (action === "retry" ? retryImport(id) : reconcileImport(id));
      await load();
    },
    [load],
  );

  const gate = readStorageGate({ importsAvailable });
  const rows = imports ?? [];
  const strategy = expectedStrategy(RECORDED_EXPANSION_EVIDENCE, {
    retainSource: false,
  });

  return (
    <div className="w-full space-y-6">
      <WorkflowSteps current="/admin/imports" />
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => void load()}
          disabled={isLoading}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-bold text-white/70 transition hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <RefreshCw size={15} className={isLoading ? "animate-spin" : ""} />
          {t("admin.imports.refresh")}
        </button>
      </div>

      <header>
        <h1 className="text-3xl font-black text-white">
          {t("admin.imports.title")}
        </h1>

        <p className="mt-1 text-sm font-semibold text-white/50">
          {t("admin.imports.description")}
        </p>
      </header>

      {!gate.mayMutate ? (
        <section className="rounded-3xl border border-amber-400/30 bg-amber-400/10 p-5">
          <div className="flex items-center gap-2">
            <Lock size={18} className="text-amber-200" />
            <h2 className="text-lg font-black text-amber-100">
              {t("admin.imports.gate.title")}
            </h2>
          </div>

          <p className="mt-2 text-sm font-semibold text-amber-100/85">
            {t("admin.imports.gate.notConfigured")}
          </p>

          {/*
            Recorded, not measured now. The drive is out of scope until it has
            been imaged, so the page replays a note and says when it was taken
            rather than asking the volume anything.
          */}
          <p className="mt-3 text-xs font-medium text-amber-100/60">
            {t("admin.imports.gate.recorded")}:{" "}
            {RECORDED_EXPANSION_EVIDENCE.volume},{" "}
            {RECORDED_EXPANSION_EVIDENCE.fileSystem},{" "}
            {RECORDED_EXPANSION_EVIDENCE.hardlinksSupported
              ? t("admin.imports.gate.hardlinksYes")
              : t("admin.imports.gate.hardlinksNo")}
            {" · "}
            {t("admin.imports.gate.wouldUse")}:{" "}
            {t(
              `admin.imports.strategy.${strategy}` as "admin.imports.strategy.copy",
            )}
            {" · "}
            {t("admin.imports.gate.recordedOn")}{" "}
            {RECORDED_EXPANSION_EVIDENCE.recordedOn}
          </p>
        </section>
      ) : null}

      {failure ? (
        <p
          role="alert"
          className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm font-bold text-red-200"
        >
          {t(failure as "admin.imports.loadFailed")}
        </p>
      ) : null}

      {!isLoading && rows.length === 0 && !failure ? (
        <p className="rounded-3xl border border-white/10 bg-white/[0.04] px-5 py-8 text-center text-sm font-semibold text-white/45">
          {t("admin.imports.empty")}
        </p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`rounded-2xl border p-4 ${
              ATTENTION_STATES.includes(row.state)
                ? "border-amber-400/30 bg-amber-400/[0.07]"
                : "border-white/10 bg-black/25"
            }`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-base font-black text-white">
                {row.target.title}
              </span>

              <span className="text-sm font-bold text-white/60">
                {t(
                  `admin.imports.state.${row.state}` as "admin.imports.state.committed",
                )}
              </span>
            </div>

            <p className="mt-1 text-xs font-medium text-white/40">
              {row.strategy
                ? t(
                    `admin.imports.strategy.${row.strategy}` as "admin.imports.strategy.copy",
                  )
                : t("admin.imports.strategyUnknown")}
              {row.isUpgrade ? ` · ${t("admin.imports.upgrade")}` : ""}
              {row.attempt > 1
                ? ` · ${t("admin.imports.attempt")} ${row.attempt}`
                : ""}
            </p>

            {/* Library-relative, because the server sends nothing else. */}
            {row.files.length > 0 ? (
              <ul className="mt-2 space-y-0.5">
                {row.files.map((file, index) => (
                  <li
                    key={`${file.destination ?? file.role}-${index}`}
                    className="break-all text-xs font-medium text-white/40"
                  >
                    {file.destination ?? file.role} · {file.state}
                  </li>
                ))}
              </ul>
            ) : null}

            {row.driveUpload ? (
              <div className="mt-3">
                <DriveUploadPanel
                  upload={row.driveUpload}
                  nowMs={nowMs}
                  t={t}
                />
              </div>
            ) : null}

            {row.failureClass ? (
              <p className="mt-2 text-xs font-bold text-amber-200">
                {row.failureClass}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {row.state === "failed" || row.state === "needs_attention" ? (
                <button
                  type="button"
                  onClick={() => void act(row.id, "retry")}
                  className="rounded-full border border-white/15 bg-white/[0.08] px-3 py-1.5 text-xs font-black text-white/80 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  {t("admin.imports.retry")}
                </button>
              ) : null}

              {row.state === "uncertain" || row.state === "committing" ? (
                <button
                  type="button"
                  onClick={() => void act(row.id, "reconcile")}
                  className="rounded-full border border-white/15 bg-white/[0.08] px-3 py-1.5 text-xs font-black text-white/80 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  {t("admin.imports.reconcile")}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
