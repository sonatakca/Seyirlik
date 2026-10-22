import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Archivo Variable",
          "Archivo Fallback",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
      boxShadow: {
        glow: "0 0 34px rgba(20, 184, 166, 0.18)",
        "cinematic-card": "var(--shadow-cinematic-card)",
        "cinematic-card-hover": "var(--shadow-cinematic-card-hover)",
        "floating-panel": "var(--shadow-floating-panel)",
        "artwork-glow": "var(--shadow-artwork-glow)",
        "player-controls": "var(--shadow-player-controls)",
        "button-glow": "var(--shadow-button-glow)",
        "soft-inset": "var(--shadow-soft-inset)",
      },
    },
  },
  plugins: [],
} satisfies Config;
