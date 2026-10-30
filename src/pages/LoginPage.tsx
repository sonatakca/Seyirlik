import { useEffect, FormEvent, useState } from "react";
import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useReducedMotion,
  type Variants,
} from "framer-motion";
import { move, settle } from "../lib/compositorMotion";
import { Lock, User } from "lucide-react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import appIcon from "../assets/AppIcon2.png";
import { Button } from "../components/Button";
import { ErrorMessage } from "../components/ErrorMessage";
import { AnimatedText } from "../components/AnimatedText";
import { AnimatedWidth } from "../components/AnimatedWidth";
import { useLanguage } from "../i18n/LanguageContext";
import { ownApiClient } from "../api/ownApi/client";
import { isAuthenticated, setAuthSession } from "../lib/authStorage";
import { markLoginConfettiPending } from "../lib/homeConfetti";
import { afterLoginPath, DEFAULT_AFTER_LOGIN_PATH } from "../lib/loginRedirect";
import { setPageTitle } from "../lib/pageTitle";
import { AuthBackdrop } from "../components/auth/AuthBackdrop";

const ARRIVE: [number, number, number, number] = [0.16, 1, 0.3, 1];

// The sign-in card assembles top to bottom: mark, name, heading, form. One
// short sequence on the one page that is always seen first.
const entrance: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.08, delayChildren: 0.12 } },
};
// Whole transforms, which framer-motion hands to the compositor.
const rise: Variants = {
  hidden: { opacity: 0, transform: move({ y: 14 }) },
  shown: {
    opacity: 1,
    ...settle,
    transition: { duration: 0.6, ease: ARRIVE },
  },
};
const markArrives: Variants = {
  hidden: { opacity: 0, transform: move({ y: 10, scale: 0.86 }) },
  shown: {
    opacity: 1,
    ...settle,
    transition: { duration: 0.7, ease: ARRIVE },
  },
};
const fade: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.4 } },
};

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const formControls = useAnimationControls();

  useEffect(() => {
    setPageTitle(`${t("auth.login")} · Seyirlik`, {
      canonicalPath: "/login",
      robots: "index, follow",
    });
  }, [t]);

  // A shared link opened while signed out comes back here as `?next=`.
  const destination = afterLoginPath(location.search);

  if (isAuthenticated()) {
    return <Navigate to={destination} replace />;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      // The session itself is an HttpOnly cookie the server sets; what is kept
      // here is only enough to render the shell before `/auth/me` resolves.
      const user = await ownApiClient.login({ username, password });
      setAuthSession({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        isAdministrator: user.isAdministrator,
      });
      // The welcome confetti belongs to the home page; a shared link is
      // opened as it is.
      if (destination === DEFAULT_AFTER_LOGIN_PATH) markLoginConfettiPending();
      navigate(destination, { replace: true });
    } catch (loginError) {
      const message =
        loginError instanceof Error
          ? loginError.message
          : t("auth.loginFailed");
      setError(`${t("auth.failedMessagePrefix")} ${message}`);
      // A refusal is felt before it is read: the card shakes its head.
      if (!shouldReduceMotion) {
        void formControls.start({
          transform: [0, -10, 8, -5, 3, 0].map((x) => move({ x })),
          transition: { duration: 0.42, ease: "easeInOut" },
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

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
            variants={shouldReduceMotion ? fade : markArrives}
            src={appIcon}
            alt=""
            className="mx-auto h-16 w-16 rounded-2xl object-cover shadow-2xl"
          />
          <motion.p
            variants={shouldReduceMotion ? fade : rise}
            className="mt-4 text-sm font-semibold text-[var(--accent)]"
          >
            Seyirlik
          </motion.p>
          <motion.h1
            variants={shouldReduceMotion ? fade : rise}
            className="text-3xl font-black"
          >
            {t("auth.signIn")}
          </motion.h1>
        </div>

        <motion.div variants={shouldReduceMotion ? fade : rise}>
          <motion.form
            animate={formControls}
            onSubmit={handleSubmit}
            className="rounded-lg border border-white/10 bg-black/[0.55] p-5 shadow-2xl backdrop-blur sm:p-6"
          >
            <label
              htmlFor="username"
              className="block text-sm font-semibold text-zinc-100"
            >
              {t("auth.username")}
            </label>
            <div className="relative mt-2">
              <User
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
                size={18}
              />
              <input
                id="username"
                autoComplete="username"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="min-h-12 w-full rounded-lg border border-white/10 bg-white/10 py-3 pl-10 pr-4 text-white outline-none transition placeholder:text-zinc-500 focus:border-[var(--accent)] focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
              />
            </div>

            <label
              htmlFor="password"
              className="mt-5 block text-sm font-semibold text-zinc-100"
            >
              {t("auth.password")}
            </label>
            <div className="relative mt-2">
              <Lock
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
                size={18}
              />
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("auth.noPasswordPlaceholder")}
                className="min-h-12 w-full rounded-lg border border-white/10 bg-white/10 py-3 pl-10 pr-4 text-white outline-none transition placeholder:text-zinc-500 focus:border-[var(--accent)] focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
              />
            </div>

            <AnimatePresence initial={false}>
              {error ? (
                <motion.div
                  key="login-error"
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
                  <div className="pt-5">
                    <ErrorMessage
                      title={t("auth.failedTitle")}
                      message={error}
                    />
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <Button
              type="submit"
              className="mt-6 w-full"
              disabled={isSubmitting}
            >
              <AnimatedWidth
                value={isSubmitting ? t("auth.signingIn") : t("auth.signIn")}
              >
                <span className="inline-flex py-1 leading-normal">
                  <AnimatedText
                    value={
                      isSubmitting ? t("auth.signingIn") : t("auth.signIn")
                    }
                  />
                </span>
              </AnimatedWidth>
            </Button>
          </motion.form>
        </motion.div>

        <motion.p
          variants={shouldReduceMotion ? fade : rise}
          className="mt-6 text-center text-sm font-medium text-white/60"
        >
          {t("signup.noAccount")}{" "}
          <Link
            to="/signup"
            className="font-bold text-white underline decoration-white/30 underline-offset-4 transition hover:decoration-[var(--accent)] focus:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {t("signup.createInstead")}
          </Link>
        </motion.p>
      </motion.section>
    </main>
  );
}
