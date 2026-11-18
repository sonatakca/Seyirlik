import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

/**
 * Lint rules for Seyirlik.
 *
 * Deliberately narrow. Prettier owns formatting, and the test suite owns
 * behaviour, so the only rules kept here are the ones that catch a class of
 * bug review keeps missing: unused code left behind after a refactor, hook
 * dependency mistakes, and `any` creeping back into typed boundaries.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dev-dist/**",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Standalone Node scripts (tooling, key generation): Node's globals, not a
  // browser's.
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: globals.node },
  },

  // The control dashboard's page script, served to the browser unbundled.
  {
    files: ["control/public/**/*.js"],
    languageOptions: { globals: globals.browser, sourceType: "script" },
  },

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Without this, a component that is only ever referenced from JSX looks
      // unused, and the unused-vars rule will happily tell you to delete it.
      "react/jsx-uses-vars": "error",

      ...reactHooks.configs.recommended.rules,

      /*
       * These are warnings rather than errors, and the distinction is
       * deliberate.
       *
       * `rules-of-hooks` stays an error: it catches hook order changing
       * between renders, which is a real defect and was one when this gate
       * was first switched on.
       *
       * The rules below are the react-hooks v7 compiler-era additions. They
       * flag around a hundred places in the player, hero, and library
       * components — genuine improvements, but each one is a behavioural
       * change inside components of several thousand lines with no browser
       * coverage yet. Failing the build on them today would mean either a
       * blocked pipeline or a rushed refactor. They are visible, counted, and
       * belong with the component-splitting work, not with turning CI on.
       */
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/exhaustive-deps": "warn",

      // An unused import or variable is usually the residue of a half-finished
      // change. Leading underscore is the documented way to say "deliberate".
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          // `const { onClick, ...rest } = props` names a property in order to
          // keep it out of `rest`. That is a use, not an oversight.
          ignoreRestSiblings: true,
        },
      ],

      // `any` at a boundary silently disables every other check behind it.
      "@typescript-eslint/no-explicit-any": "error",

      // `let` that is never reassigned reads as though it might be.
      "prefer-const": "error",

      // Comparing against a value of a different type is nearly always a bug.
      eqeqeq: ["error", "smart"],
    },
  },

  {
    files: ["src/**/*.tsx"],
    rules: {
      // Fast refresh silently stops working for a module that exports more than
      // its component, which is confusing rather than obviously broken.
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },

  {
    files: ["**/*.test.{ts,tsx}", "**/*.integration.test.ts", "e2e/**/*.ts"],
    rules: {
      // Tests deliberately construct partial and malformed values to exercise
      // the paths that handle them.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
