import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "flag-icons/css/flag-icons.min.css";
// Archivo, self-hosted with both axes: weight for hierarchy, width for the
// condensed display role. Subsets load by unicode-range, so Turkish letters
// fetch latin-ext only when a page actually uses them.
import "@fontsource-variable/archivo/wdth.css";
import App from "./App";
import { LanguageProvider } from "./i18n/LanguageContext";
import { applyStoredAccentTheme } from "./lib/accentTheme";
import { startAppUpdateWatch } from "./lib/appVersion/appUpdate";
import { syncShimmerSweeps } from "./lib/shimmerSync";
import "./index.css";
// These styles remain eager, and ordered after Tailwind/global rules, to match
// the original single-stylesheet first paint and cascade.
import "./components/player/CustomVideoPlayer.css";
import "./pages/BookReaderPage.css";
import "./components/MediaCard.css";
import "./components/HeroSection.css";
import "./components/Skeletons.css";
import "./features/partyWatch/PartyWatch.css";
import "./components/TimedCarouselIndicators.css";
import "./components/RouteColorTransition.css";

const userAgent = navigator.userAgent;

if (
  /Chrome|CriOS|Chromium/.test(userAgent) &&
  !/Edg|OPR|Opera|Safari\/.*Version/.test(userAgent)
) {
  document.documentElement.classList.add("browser-chrome");
}

applyStoredAccentTheme();
startAppUpdateWatch();
syncShimmerSweeps();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </LanguageProvider>
  </React.StrictMode>,
);
