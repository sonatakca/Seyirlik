import { useEffect } from "react";
import { ArrowRight, Gauge } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../i18n/LanguageContext";
import { setMotionLabEnabled, useMotionLabEnabled } from "../lib/heroMotionLab";
import { setPageTitle } from "../lib/pageTitle";

/** Switches the motion lab's panel on the real home hero on or off. */
export function MotionLabPage() {
  const { t } = useLanguage();
  const isOn = useMotionLabEnabled();

  useEffect(() => {
    setPageTitle(`${t("devtools.motionLab.title")} · Seyirlik`, {
      canonicalPath: "/dev/motion-lab",
      robots: "noindex, nofollow",
    });
  }, [t]);

  return (
    <div className="w-full space-y-6 pb-20">
      <section className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] p-6 shadow-2xl backdrop-blur-xl sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
              {t("devtools.card.motionLab.tag")}
            </p>
            <div className="mt-3 flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-white">
                <Gauge size={23} />
              </div>
              <div>
                <h1 className="text-3xl font-black text-white sm:text-4xl">
                  {t("devtools.motionLab.title")}
                </h1>
                <p className="mt-2 text-sm font-medium leading-6 text-white/58 sm:text-base">
                  {t("devtools.motionLab.description")}
                </p>
              </div>
            </div>
          </div>

          <div className="w-full shrink-0 space-y-3 lg:w-80">
            <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="text-sm font-black text-white">
                  {t("devtools.motionLab.panelLabel")}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOn}
                  aria-label={t("devtools.motionLab.panelLabel")}
                  onClick={() => setMotionLabEnabled(!isOn)}
                  className={`relative h-8 w-14 shrink-0 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/70 ${
                    isOn
                      ? "border-[var(--accent)]/60 bg-[var(--accent)]"
                      : "border-white/15 bg-white/10"
                  }`}
                >
                  <span
                    className={`absolute left-0 top-1 h-6 w-6 rounded-full bg-white shadow-lg transition-transform ${
                      isOn ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
              <p
                className={`mt-3 text-xs font-black uppercase tracking-[0.12em] ${
                  isOn ? "text-[var(--accent)]" : "text-white/35"
                }`}
              >
                {isOn
                  ? t("devtools.motionLab.panelOn")
                  : t("devtools.motionLab.panelOff")}
              </p>
            </div>

            <Link
              to="/home"
              onClick={() => setMotionLabEnabled(true)}
              className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl border border-white/15 bg-black/40 px-6 text-sm font-black text-white transition hover:border-white/30 hover:bg-white/10"
            >
              {t("devtools.motionLab.open")}
              <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
