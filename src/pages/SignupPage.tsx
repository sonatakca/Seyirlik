import { FormEvent, useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useReducedMotion,
  type Variants,
} from "framer-motion";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import appIcon from "../assets/AppIcon2.png";
import { Button } from "../components/Button";
import { ErrorMessage } from "../components/ErrorMessage";
import { AnimatedText } from "../components/AnimatedText";
import { AnimatedWidth } from "../components/AnimatedWidth";
import { AuthBackdrop } from "../components/auth/AuthBackdrop";
import {
  TurnstileWidget,
  type TurnstileHandle,
} from "../components/auth/TurnstileWidget";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";
import {
  OwnApiClientError,
  ownApiClient,
  type OwnApiSignupConfig,
} from "../api/ownApi/client";
import { isAuthenticated, setAuthSession } from "../lib/authStorage";
import { markLoginConfettiPending } from "../lib/homeConfetti";
import { move, settle } from "../lib/compositorMotion";
import { setPageTitle } from "../lib/pageTitle";

const ARRIVE: [number, number, number, number] = [0.16, 1, 0.3, 1];

const entrance: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.08, delayChildren: 0.12 } },
};
const rise: Variants = {
  hidden: { opacity: 0, transform: move({ y: 14 }) },
  shown: { opacity: 1, ...settle, transition: { duration: 0.6, ease: ARRIVE } },
};
const fade: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.4 } },
};

// The server's rules, mirrored so a mistake is named before a bot check and
// an invite use are spent on it. The server still decides.
const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;
const MIN_PASSWORD_LENGTH = 8;
const INVITE_CHARACTERS = /[^0-9A-Z]/g;

type Field = "displayName" | "username" | "password" | "inviteCode";

/** `7kq2m9xd` → `7KQ2-M9XD`, as the person types. */
function formatInviteCode(value: string): string {
  const characters = value
    .toUpperCase()
    .replace(INVITE_CHARACTERS, "")
    .slice(0, 12);
  return characters.match(/.{1,4}/g)?.join("-") ?? "";
}

function normalizedUsername(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${Array.from(words[0] ?? "")[0] ?? ""}${Array.from(words.at(-1) ?? "")[0] ?? ""}`
      : Array.from(words[0] ?? "")
          .slice(0, 2)
          .join("");
  return letters.toLocaleUpperCase();
}

function errorFor(error: unknown): { key: TranslationKey; field?: Field } {
  if (!(error instanceof OwnApiClientError)) {
    return { key: "signup.error.generic" };
  }
  switch (error.code) {
    case "INVITE_INVALID":
      return { key: "signup.error.invite", field: "inviteCode" };
    case "USERNAME_TAKEN":
      return { key: "signup.error.usernameTaken", field: "username" };
    case "SIGNUP_CHECK_FAILED":
      return { key: "signup.error.check" };
    case "SIGNUP_CHECK_UNAVAILABLE":
      return { key: "signup.error.checkUnavailable" };
    case "AUTH_RATE_LIMITED":
      return { key: "signup.error.rateLimited" };
    case "SIGNUP_CLOSED":
      return { key: "signup.closedMessage" };
    case "VALIDATION_FAILED":
      if (/display name/i.test(error.message))
        return { key: "signup.error.displayName", field: "displayName" };
      if (/username/i.test(error.message))
        return { key: "signup.error.username", field: "username" };
      if (/password/i.test(error.message))
        return { key: "signup.error.password", field: "password" };
      return { key: "signup.error.generic" };
    default:
      return { key: "signup.error.generic" };
  }
}

const inputClassName =
  "min-h-12 w-full rounded-lg border bg-white/10 px-4 py-3 text-white outline-none transition-[border-color,background-color] placeholder:text-zinc-500 focus:bg-white/[0.13] aria-[invalid=true]:border-rose-300/60";

function FieldShell({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-zinc-100">
        {label}
      </label>
      <div className="mt-2">{children}</div>
      <p
        id={`${id}-hint`}
        className={`mt-1.5 text-xs font-medium leading-5 ${
          error ? "text-rose-200" : "text-white/50"
        }`}
      >
        {error ?? hint}
      </p>
    </div>
  );
}

export function SignupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, language } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const formControls = useAnimationControls();
  const turnstileRef = useRef<TurnstileHandle>(null);

  const [config, setConfig] = useState<OwnApiSignupConfig | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(() =>
    formatInviteCode(new URLSearchParams(location.search).get("invite") ?? ""),
  );
  const [token, setToken] = useState<string | null>(null);
  const [checkBlocked, setCheckBlocked] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<Field, string>>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setPageTitle(`${t("signup.pageTitle")} · Seyirlik`, {
      canonicalPath: "/signup",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    ownApiClient
      .getSignupConfig()
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch(() => {
        if (!cancelled) setConfigFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (isAuthenticated()) return <Navigate to="/" replace />;

  const shake = () => {
    if (shouldReduceMotion) return;
    void formControls.start({
      transform: [0, -10, 8, -5, 3, 0].map((x) => move({ x })),
      transition: { duration: 0.42, ease: "easeInOut" },
    });
  };

  const validate = (): Partial<Record<Field, string>> => {
    const found: Partial<Record<Field, string>> = {};
    if (!displayName.trim()) found.displayName = t("signup.error.displayName");
    if (!USERNAME.test(normalizedUsername(username)))
      found.username = t("signup.error.username");
    if (Array.from(password).length < MIN_PASSWORD_LENGTH)
      found.password = t("signup.error.password");
    if (inviteCode.replace(/-/g, "").length !== 12)
      found.inviteCode = t("signup.error.invite");
    return found;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const found = validate();
    setFieldErrors(found);
    if (Object.keys(found).length > 0) {
      shake();
      return;
    }
    if (!token) return;

    setIsSubmitting(true);
    try {
      const user = await ownApiClient.signup({
        displayName,
        username,
        password,
        inviteCode,
        turnstileToken: token,
      });
      setAuthSession({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        isAdministrator: user.isAdministrator,
      });
      markLoginConfettiPending();
      navigate("/", { replace: true });
    } catch (signupError) {
      const { key, field } = errorFor(signupError);
      if (field) setFieldErrors({ [field]: t(key) });
      else setError(t(key));
      // The token was spent on this attempt whatever the answer.
      turnstileRef.current?.reset();
      shake();
    } finally {
      setIsSubmitting(false);
    }
  };

  const shownName = displayName.trim();
  const shownUsername = normalizedUsername(username);
  const closed = configFailed || config?.enabled === false;
  const submitLabel = isSubmitting
    ? t("signup.submitting")
    : !token && !checkBlocked && config?.enabled
      ? t("signup.checking")
      : t("signup.submit");

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10 text-white">
      <AuthBackdrop />

      <motion.section
        className="w-full max-w-md"
        variants={entrance}
        initial="hidden"
        animate="shown"
      >
        <div className="mb-8 text-center">
          <motion.img
            variants={shouldReduceMotion ? fade : rise}
            src={appIcon}
            alt=""
            className="mx-auto h-16 w-16 rounded-2xl object-cover shadow-2xl"
          />
          <motion.h1
            variants={shouldReduceMotion ? fade : rise}
            className="mt-5 text-3xl font-black"
          >
            {t("signup.title")}
          </motion.h1>
          <motion.p
            variants={shouldReduceMotion ? fade : rise}
            className="mx-auto mt-2 max-w-xs text-sm font-medium leading-6 text-white/60"
          >
            {t("signup.lead")}
          </motion.p>
        </div>

        <motion.div variants={shouldReduceMotion ? fade : rise}>
          {closed ? (
            <ErrorMessage
              title={t("signup.closedTitle")}
              message={t("signup.closedMessage")}
            />
          ) : (
            <motion.form
              animate={formControls}
              onSubmit={handleSubmit}
              noValidate
              className="space-y-5 rounded-lg border border-white/10 bg-black/[0.55] p-5 shadow-2xl backdrop-blur sm:p-6"
            >
              {/* The split the form is about, shown as it is typed: the
                  name others see, and the one only you sign in with. */}
              <div
                aria-live="polite"
                className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-3"
              >
                <span
                  aria-hidden
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-black tracking-wide text-white/85"
                >
                  {initialsOf(shownName) || "·"}
                </span>
                <span className="min-w-0">
                  <span className="block text-[0.6875rem] font-black uppercase tracking-[0.12em] text-white/50">
                    {t("signup.preview")}
                  </span>
                  <span
                    className={`block truncate text-base font-bold ${
                      shownName ? "text-white" : "text-white/35"
                    }`}
                  >
                    {shownName || t("signup.displayNamePlaceholder")}
                  </span>
                  <span className="block truncate text-xs font-semibold text-white/50">
                    {t("signup.previewSignsIn").replace(
                      "{username}",
                      shownUsername || "…",
                    )}
                  </span>
                </span>
              </div>

              <FieldShell
                id="displayName"
                label={t("signup.displayName")}
                hint={t("signup.displayNameHint")}
                error={fieldErrors.displayName}
              >
                <input
                  id="displayName"
                  autoComplete="name"
                  maxLength={100}
                  value={displayName}
                  aria-invalid={Boolean(fieldErrors.displayName)}
                  aria-describedby="displayName-hint"
                  onChange={(event) => setDisplayName(event.target.value)}
                  className={`${inputClassName} border-white/10 focus:border-[var(--accent)]`}
                />
              </FieldShell>

              <FieldShell
                id="username"
                label={t("signup.username")}
                hint={t("signup.usernameHint")}
                error={fieldErrors.username}
              >
                <div className="relative">
                  <span
                    aria-hidden
                    className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-semibold text-zinc-500"
                  >
                    @
                  </span>
                  <input
                    id="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={32}
                    value={username}
                    aria-invalid={Boolean(fieldErrors.username)}
                    aria-describedby="username-hint"
                    onChange={(event) => setUsername(event.target.value)}
                    className={`${inputClassName} border-white/10 pl-9 focus:border-[var(--accent)]`}
                  />
                </div>
              </FieldShell>

              <FieldShell
                id="password"
                label={t("signup.password")}
                hint={t("signup.passwordHint")}
                error={fieldErrors.password}
              >
                <input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  aria-invalid={Boolean(fieldErrors.password)}
                  aria-describedby="password-hint"
                  onChange={(event) => setPassword(event.target.value)}
                  className={`${inputClassName} border-white/10 focus:border-[var(--accent)]`}
                />
              </FieldShell>

              <FieldShell
                id="inviteCode"
                label={t("signup.inviteCode")}
                hint={t("signup.inviteCodeHint")}
                error={fieldErrors.inviteCode}
              >
                <input
                  id="inviteCode"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="text"
                  placeholder="XXXX-XXXX-XXXX"
                  value={inviteCode}
                  aria-invalid={Boolean(fieldErrors.inviteCode)}
                  aria-describedby="inviteCode-hint"
                  onChange={(event) =>
                    setInviteCode(formatInviteCode(event.target.value))
                  }
                  className={`${inputClassName} border-white/10 font-bold uppercase tabular-nums tracking-[0.18em] focus:border-[var(--accent)]`}
                />
              </FieldShell>

              {config?.enabled ? (
                <TurnstileWidget
                  ref={turnstileRef}
                  siteKey={config.turnstileSiteKey}
                  language={language}
                  onToken={setToken}
                  onUnavailable={() => setCheckBlocked(true)}
                />
              ) : null}

              <AnimatePresence initial={false}>
                {error || checkBlocked ? (
                  <motion.div
                    key="signup-error"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{
                      opacity: 1,
                      height: "auto",
                      transition: { duration: 0.32, ease: ARRIVE },
                    }}
                    exit={{
                      opacity: 0,
                      height: 0,
                      transition: { duration: 0.18 },
                    }}
                    className="overflow-hidden"
                  >
                    <ErrorMessage
                      title={t("signup.failedTitle")}
                      message={error ?? t("signup.error.checkBlocked")}
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <Button
                type="submit"
                className="w-full"
                disabled={isSubmitting || !token}
              >
                <AnimatedWidth value={submitLabel}>
                  <span className="inline-flex py-1 leading-normal">
                    <AnimatedText value={submitLabel} />
                  </span>
                </AnimatedWidth>
              </Button>
            </motion.form>
          )}
        </motion.div>

        <motion.p
          variants={shouldReduceMotion ? fade : rise}
          className="mt-6 text-center text-sm font-medium text-white/60"
        >
          {t("signup.haveAccount")}{" "}
          <Link
            to="/login"
            className="font-bold text-white underline decoration-white/30 underline-offset-4 transition hover:decoration-[var(--accent)] focus:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {t("signup.signInInstead")}
          </Link>
        </motion.p>
      </motion.section>
    </main>
  );
}
