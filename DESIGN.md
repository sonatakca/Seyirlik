---
name: Seyirlik
description: A self-hosted media server designed as a private screening room with a projection booth behind it.
colors:
  seyirlik-teal: "#467a6c"
  seyirlik-teal-hover: "#75a27b"
  screening-void: "#050607"
  glass-surface: "rgba(255, 255, 255, 0.065)"
  glass-surface-hover: "rgba(255, 255, 255, 0.11)"
  text-primary: "#f8fafc"
  text-secondary: "rgba(226, 232, 240, 0.72)"
  hairline-border: "rgba(255, 255, 255, 0.12)"
  status-success: "#34d399"
  status-warning: "#fbbf24"
  status-critical: "#f87171"
  status-danger-action: "#fda4af"
  reader-night-ink: "#e8e5de"
  reader-night-ink2: "rgba(232, 229, 222, 0.66)"
  reader-night-ink3: "rgba(232, 229, 222, 0.52)"
  reader-dim-ground: "#1b1c1e"
  reader-dim-ink: "#d9d6cf"
  reader-dim-ink2: "rgba(217, 214, 207, 0.7)"
  reader-dim-ink3: "rgba(217, 214, 207, 0.57)"
  reader-sepia-ground: "#efe4cf"
  reader-sepia-ink: "#2b2218"
  reader-sepia-ink2: "rgba(43, 34, 24, 0.8)"
  reader-sepia-ink3: "rgba(43, 34, 24, 0.67)"
  reader-paper-ground: "#f7f6f2"
  reader-paper-ink: "#1c1c1b"
  reader-paper-ink2: "rgba(28, 28, 27, 0.75)"
  reader-paper-ink3: "rgba(28, 28, 27, 0.62)"
  reader-mark-night: "#7fb8a2"
  reader-mark-dim: "#86bba6"
  reader-mark-light: "#2f6a57"
typography:
  display:
    fontFamily: "'Archivo Variable', 'Archivo Fallback', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.25rem, 4vw + 1rem, 4.5rem)"
    fontWeight: 900
    fontStretch: "78%"
    lineHeight: 0.95
    letterSpacing: "normal"
  headline:
    fontFamily: "'Archivo Variable', 'Archivo Fallback', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 900
    fontStretch: "78%"
    lineHeight: 1.2
    letterSpacing: "normal"
  title:
    fontFamily: "'Archivo Variable', 'Archivo Fallback', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "'Archivo Variable', 'Archivo Fallback', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "'Archivo Variable', 'Archivo Fallback', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 900
    lineHeight: 1.15
    letterSpacing: "0.12em"
  book:
    fontFamily: "'Seyirlik Literata', Literata, Georgia, 'Times New Roman', serif"
    fontSize: "clamp(1rem, 0.5rem + 0.9vw, 1.1875rem)"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "normal"
  book-numeral:
    fontFamily: "'Seyirlik Archivo', 'Archivo Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: "5em"
    fontWeight: 900
    fontStretch: "72%"
    lineHeight: 0.86
    letterSpacing: "-0.02em"
  reader-title:
    fontFamily: "'Archivo Variable', 'Archivo Fallback', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "normal"
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  full: "9999px"
components:
  button-primary:
    backgroundColor: "{colors.seyirlik-teal}"
    textColor: "#09090b"
    typography: "{typography.title}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  button-primary-hover:
    backgroundColor: "{colors.seyirlik-teal-hover}"
  button-secondary:
    backgroundColor: "{colors.glass-surface-hover}"
    textColor: "{colors.text-primary}"
    typography: "{typography.title}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "#e4e4e7"
    typography: "{typography.title}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  media-card:
    backgroundColor: "{colors.glass-surface}"
    rounded: "{rounded.md}"
  admin-card:
    backgroundColor: "{colors.glass-surface}"
    rounded: "{rounded.lg}"
    padding: "1rem 1.25rem"
---

# Design System: Seyirlik

## Overview

**Creative North Star: "The Private Screening Room"**

Seyirlik is one facility with two rooms. The audience-facing side — home, library, hero, the player — is the screening room itself: a dark, immersive space designed to disappear behind the poster art and video it's showing, lit by one restrained signal color. The admin side — scanning, processing, artwork, users — is the projection booth behind the screen: quieter, flatter, information-dense, precise, and built for repeated operational use rather than atmosphere. Both rooms belong to the same building, built from the same materials (near-black ground, Seyirlik Teal, the same heavy-weight Archivo type, the same two-radius shape language), but the booth never borrows the screening room's decoration to prove they match.

Deep black, cinematic hierarchy, restrained teal accenting, confident heavy typography, strong media imagery, and a real sense of depth are the durable identity. The exact intensity of glass blur, glow, shadow softness, and gradients are implementation choices within that identity, refinable whenever a change improves clarity, performance, hierarchy, or restraint — they are not, themselves, what makes Seyirlik look like Seyirlik.

The book reader (`/read/:id`) is a reading seat inside the screening room, not a third room: the same void, the same Archivo chrome, the same glass and the same accent, with the house lights brought down onto a single column of Literata. Its idea is that the reading line is lit: the paragraph (or, if the reader chooses, the line) at 40% of the viewport carries full ink and the text above and below falls off like screen glow, and position is shown as a ruler in the right margin rather than as a page counter. The chrome stays away while reading and comes only when asked for.

**Key Characteristics:**

- Near-black ground throughout, lit by artwork and screen glow rather than by a light UI chrome.
- One accent color (Seyirlik Teal), used sparingly as a signal, never as a fill.
- Weight and width _are_ the display system — no separate display face, just Archivo pushed to 900 and, for titles, condensed.
- Two-radius shape grammar: `rounded-full` for every control, a small radius step for buttons and cards.
- Screening room surfaces carry cinematic depth (layered shadow, glass blur, accent-tinted glow); control-booth surfaces are flat and dense by design, not by neglect.
- The book reader is the one place a second face appears (Literata, for the book's own text) and the one place a ground may go light (the reader's Loş, Sepya and Kağıt lights, scoped to the reader shell).

## Colors

The palette is almost monochrome by design: everything is near-black, near-white, or translucent white, with exactly one hue doing all the signaling.

### Primary

- **Seyirlik Teal** (`#467a6c`) / **hover** (`#75a27b`): the one accent in the system. Used for hover glow, progress fills, focus rings, active/selected state, and the rare primary call-to-action. Never the dominant color of a screen — its rarity is what makes it read as a signal.

### Neutral

- **Screening Void** (`#050607`, deepening to `#000` at the html root): the base ground of every surface.
- **Glass Surface** (`rgba(255,255,255,0.065)`) / **hover** (`rgba(255,255,255,0.11)`): the translucent panel fill used for cards, chips, and controls floated over the void.
- **Hairline Border** (`rgba(255,255,255,0.12)`): the only border weight in the system; borders are a whisper, not a frame.
- **Text Primary** (`#f8fafc`) / **Text Secondary** (`rgba(226,232,240,0.72)`): near-white for headings and primary copy, translucent for supporting copy — opacity does the work a second gray would otherwise do.

### Status (functional, Control Booth)

- **Success** (`#34d399`, emerald): healthy/succeeded state — status dots, watched indicators.
- **Warning** (`#fbbf24`, amber): degraded/paused state — non-blocking alerts.
- **Critical** (`#f87171`, red): blocked/failed state — the storage-quarantine banner and hard failures.
- **Danger Action** (`#fda4af`, rose): the destructive-button variant. Deliberately a different hue family from Critical red — a button you're about to press reads differently from a state that already happened to the system.

### The Accent Ramp

The six selectable accents (`src/lib/accentTheme.ts`) are the six bars of the logo, running warm to cool: **Warm Red** (`#bd3f28`), **Amber** (`#fa9b1d`), **Gold** (`#d3ca22`), **Olive** (`#bacb7d`), **Green** (`#67a478`), **Teal** (`#337b6c`). One of them is live at any moment as `--accent`; the ramp as a whole is also available as a scale in its own right.

### Reader Lights (reader-scoped)

The reader has four lights, chosen by the person reading and applied as inline custom properties (`--rd-ground`, `--rd-ink` … `--rd-ink4`, `--rd-hair`, `--rd-mark`, `--rd-glass*`, `--rd-lift`, `--rd-selection`) on the reader shell, and injected as concrete colours into the book's epub.js iframes, where the app stylesheet never reaches (`src/pages/reader/readerModel.ts`, `themePalettes`). Each light is a full palette: ground, four ink steps, hairline, a text-safe accent ("mark"), three glass values, a lift shadow and a selection tint.

- **Gece / Night**: Screening Void (`screening-void`) is its ground; this light is the rest of Seyirlik, with warm off-white ink (`reader-night-ink`). The default.
- **Loş / Dim** (`reader-dim-ground`): a raised charcoal for readers who find pure black too hard against bright text. Ink `reader-dim-ink`.
- **Sepya / Sepia** (`reader-sepia-ground`): warm paper with brown-black ink (`reader-sepia-ink`); its lift shadow is tinted brown, not black.
- **Kağıt / Paper** (`reader-paper-ground`): near-white paper with near-black ink (`reader-paper-ink`).

Loş, Sepya and Kağıt are reader-only grounds. They exist inside the reader shell and nowhere else in Seyirlik.

Ink steps, measured on each light's own ground: **ink** (body text, 11.8–16.1:1), **ink2** (secondary text: author, chapter subtitles, active ruler figures; 6.4–7.2:1), **ink3** (tertiary text: tracked labels, time left, ruler captions, chapter times; 4.66–4.75:1), **ink4** (14–15% on dark, 11–13% on light; never text: tracks, unread chapter bars, the ruler line, hover fills, segmented-control wells). **mark** is the accent as text on that ground: a lighter teal on the dark lights (`reader-mark-night`, `reader-mark-dim`, 7.9–9.0:1) and a deep teal on the light ones (`reader-mark-light`, 5.0–5.9:1). Links in the book use mark; fills (the ruler marker, opener rule, progress hairline, focus ring, the bookmarked icon, the current chapter's mark and read bar in the contents, and the margin switches' on-dots) use the live `--accent`.

**Recorded deviation, accent reach.** The direction gave the reader's accent four uses: ruler marker, opener rule, progress hairline, focus. The build also puts it on the bookmarked-state icon, the current chapter's mark and read bar in the contents, and the on-dots of the margin switches. The finish review rated this minor and asked for it to be recorded rather than fixed. It stays within the One Signal Light Rule (each is a dot, a numeral or a 4px bar), but it is not a licence to add more. Mark is a fixed teal, so with a non-teal live accent links stay teal while the ruler marker follows the chosen accent.

### Named Rules

**The One Signal Light Rule.** Seyirlik Teal appears as a glow, a fill, a ring, or a dot — never as a background, never as a large shape. If teal is the first thing you notice on a screen, it's being overused.

**The Ramp-Is-The-Pipeline Rule.** Where a surface must tell several kinds of background work apart, it reads the accent ramp as one scale: the warm end is trouble (Warm Red = failed, Amber = needs a person), and the cool run is healthy work ordered by how far through the pipeline it has travelled — Gold (discovery: scan, probe) → Olive (description: metadata, artwork, trickplay) → Green (encoding) → Teal (export). Status always outranks the job: a failure is red whatever produced it. These are fixed points of the ramp, not the viewer's chosen `--accent`, so a colour means the same job for everyone; the derived values and their measured contrast live in `src/lib/notifications/notificationAccent.ts`. Colour is never the only code — the glyph carries the state, the card names its own work, and the scale steps down in lightness so the order survives without hue.

**The Reader-Scoped Light Rule.** A light ground (Sepya, Kağıt) or the raised Loş ground exists only inside the reader shell, chosen by the person reading. Nothing else in Seyirlik goes light to match it, and the reader never invents a fifth light without a full palette (ground, four inks, hair, mark, glass, lift, selection).

**The Fourth-Step Ink Rule.** In every reader light, ink3 is the faintest step allowed to carry text, and it clears 4.5:1 on its own ground; ink2 sits a step above it. ink4 is never text. A new light is measured before it ships.

## Typography

**Body & Display Font:** Archivo, self-hosted as a variable font with both axes (`@fontsource-variable/archivo/wdth.css`: weight 100–900, width 62–125%), falling back to `Archivo Fallback` — local Arial reshaped to Archivo's metrics so the swap does not reflow — then `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.

**Book Font:** Literata (`@fontsource-variable/literata`, optical-size axis, weights 200–900, roman and italic), loaded into the book's iframes as `Seyirlik Literata` (latin and latin-ext, so Turkish ı, ğ, ş and İ come from the same face) and into the reader chrome as `Literata Variable`, falling back to Georgia. The reader also offers Archivo (weight 450) as the book face for anyone who prefers a sans.

**Character:** One typeface carries the whole system; hierarchy is built from weight, width, size, and letter-spacing rather than a second display face. Heavy weight (900, `font-black`) is the system's display device — it's what a hero title, a stat number, and a label all reach for — and width separates what a person _reads as a title_ from what they _operate_: titles are condensed, everything else is set at normal width. Archivo is a grotesque with a poster lineage, so a condensed 900 title sits naturally over film art, while its normal width stays plain and legible down to the 10–11px labels. The hand-cut Seyirlik lettering belongs to the wordmark and loader artwork alone; it is never set as text.

### Hierarchy

- **Display** (900, 78% width, `clamp(2.25rem, 4vw + 1rem, 4.5rem)`, leading 0.95): hero titles over backdrop art, always paired with a cinematic drop-shadow so it stays legible over busy imagery.
- **Headline** (900, 78% width on title-size `h1`/`h2`, `1.5rem`, tabular-nums where numeric): page and row titles, section headers and the large stat numbers in the Control Booth.
- **Title** (700, `1rem`–`1.125rem`): card titles, button labels, nav labels.
- **Body** (600, `0.75rem`–`0.875rem`, leading 1.4–1.5): descriptions, metadata rows, supporting copy — set in Text Secondary more often than Text Primary.
- **Label** (900, `0.66rem`–`0.6875rem`, tracking `0.08em`–`0.18em`, uppercase): eyebrows, category badges, and count chips. This is the system's most-repeated typographic gesture.

### Reader Hierarchy

- **Book** (Literata 400, Archivo 450 when the reader picks the sans, `clamp(1rem, 0.5rem + 0.9vw, 1.1875rem)` × the reader's size step (80–145% in 5% steps), leading 1.45 / 1.65 / 1.9, measure 56 / 66 / 78ch): the book's running text. Paragraphs carry no space between them and a 1.35em first-line indent; `text-wrap: pretty`; a justified paragraph is set ragged right; a centred or right-aligned paragraph loses its indent. Optical sizing is on.
- **Chapter opener**: an Archivo 900 numeral at 72% width (`book-numeral`, 5em, leading 0.86) over the chapter title in Literata italic 400 at 1.45em in ink2, closed by a 36 × 2px rule in the live accent. An opener without a short numeral sets its heading in Archivo 800 at 78% width, 1.75em (h1/h2) or 1.15em (h3–h6), centred. Openers are only inferred where the evidence is strong (a run of headings at the top of a section, or a paragraph the book marks as an opening), so a calibre split in mid-chapter gets none.
- **Lead line**: a short first paragraph (≤140 characters) after an opener is set in all-small-caps, 520 weight, tracked 0.08em; in Turkish it is uppercased with `text-transform` at 0.8em instead (see the Turkish Casing Rule).
- **Drop cap**: the first long paragraph (≥200 characters) of a chapter opens with a three-line `initial-letter` in Archivo 900 at 78% width, only where the browser supports `initial-letter`.
- **Reader chrome** (Archivo): the bar title is `reader-title` (800, 0.9375rem), a sixteenth below the app's Title step so the chrome stays quieter than the book; the drawer's book title is the Headline (900, 78%, 1.5rem); chapter numerals in the contents are 900 at 72% width, 1.25rem, tabular; chapter titles 700 at 0.875rem, with nested entries at 0.8125rem 600 in ink2; author and supporting copy 0.8125rem; drawer progress, bookmark place and settings values 0.75rem; every tracked uppercase label (bar subtitle, ruler captions, time left, settings row labels, the loading line) is the system Label at 0.6875rem 900, tracked 0.13–0.14em, in ink3.
- **Specimen glyphs**: the Aa in the bar (0.8125 + 1.1875rem), the small and large A at either end of the size slider (0.8125 / 1.375rem), the Aa on each theme swatch (1.375rem) and each face sample (1.75rem) are Literata at 500–600. They are previews of the book face, sized as specimens, not steps of the text ramp. 1.1875rem is also the top of the book's body clamp.

**Off-ramp sizes that are drift, not scale:** 0.71875rem (theme names, chapter times), 0.78125rem (drawer tabs) and 0.84375rem (menu items) are thirty-second-rem steps squeezed between 0.6875, 0.75, 0.8125 and 0.875. Each is used once or twice and none carries a role the neighbouring step does not. They should land on those steps when the files are next touched; they are not part of the system.

### Named Rules

**The Weight-Not-Face Rule.** Never reach for a second font family to add hierarchy or occasion (a title card, a stat, a badge). Reach for 900, width, and letter-spacing instead. The book reader's Literata is not an exception to this: it sets the book, which is content, not hierarchy (see the Book-Face Boundary Rule).

**The Two-Widths Rule.** Titles are condensed; controls, copy, data, and labels are not. The rule lives in one place in `src/index.css`: an `h1` or `h2` set at title size (`text-lg`, 1.125rem, and up) is condensed to 78%, so a title is condensed by being a heading at title size, not by a class someone remembered. A small card or panel heading keeps normal width, and so does an uppercase heading — a label doing a label's job — because tracked caps and small text need the open counters. Never condense running text, numbers in a table, or anything below 1.125rem.

**The Book-Face Boundary Rule.** Literata sets the book's text and the things that quote or preview it (bookmark excerpts, plain-text documents, the specimen glyphs in the reader's settings) and nothing else. Chrome, labels, numerals, drop caps and opener numerals stay in Archivo, so the book is the only thing on screen in a book face.

**The Turkish Casing Rule.** Small-cap glyphs ignore Turkish casing (an i becomes a dotless I), so under `lang="tr"` the lead line is uppercased with `text-transform` instead, which gives İ. Turkish publishers often declare `en` or nothing, so a section with at least 400 letters in which ı, İ, ğ and Ğ exceed 0.8% of the letters is treated as Turkish whatever its package says. Browsers ship no Turkish hyphenation, so Turkish text gets soft hyphens from TeX patterns (words of 6+ letters, never in headings, `pre` or `code`); every other language uses the browser's `hyphens: auto`.

## Layout

The screening room and the control booth use different spatial grammars on the same grid.

**Screening room (home, library, hero, player):** a centered container (`max-width: 95%`) with generous, viewport-responsive gutters; hero sections break out full-bleed past that container to fill the viewport edge to edge. Media rows scroll horizontally with a soft edge-mask fade rather than a hard clip, so a row reads as continuing past the frame. The navbar starts fully transparent over the hero and only becomes an opaque glass bar once the page scrolls — the chrome earns its presence instead of always claiming it. Safe-area insets (`env(safe-area-inset-*)`) are load-bearing throughout, not an afterthought, because the client runs as an installed PWA on phones.

**Control booth (admin):** plain stacked/grid sections of bordered cards, no full-bleed compositions, no edge-fade scrollers — density and scanability over atmosphere.

**Book reader:** one continuous scrolled column, no pages. The column is centred at the reader's measure (56, 66 or 78ch of the book face, so it widens with the type size) with `clamp(1.25rem, 5vw, 3rem)` side padding and `clamp(4.5rem, 10vh, 6.5rem)` above. The reading line sits at 40% of the viewport. The right margin holds the position, against the window's edge (2.75rem in, 8.5rem wide, 56vh tall, vertically centred): "Bölüm sonuna ≈ N dk" at its top and the chapter ruler beneath, each of which the reader can switch off. It needs 264px beside the column; without it the ruler is not shown and the time left docks centred at the foot of the screen over a fade of the ground, coming and going with the bar. The top bar is a 4rem three-column grid (the back button alone, centred title over author · chapter, a pill of actions); at 760px and below it drops to 3.5rem, loses the author and the separator dot, settings becomes a bottom sheet, and line spacing and width collapse into one row (width is hidden). Below 380px the bookmark row's action button is hidden.

## Elevation & Depth

Elevation is deliberately hybrid, split along the Screening Room / Control Booth line rather than applied uniformly.

**Screening room:** a full named shadow vocabulary carries real depth — `cinematic-card` / `cinematic-card-hover` under posters, `floating-panel` under overlays, `artwork-glow` and `player-controls` around playback chrome, `button-glow` under primary CTAs — layered, soft-edged (30–120px blur), and darker/more dramatic on hover. Interactive chrome floated over media (icon buttons, segmented toolbars, pill inputs) is glassed: `backdrop-blur-2xl` over a near-black translucent fill. Hover states add an accent-tinted glow via `color-mix()` rather than a flat color shift.

**Control booth:** flat by contrast. Depth is conveyed by a hairline border and a faint fill-opacity step (`bg-white/[0.03]`), not by shadow or blur. No glass, no glow — clarity and scan speed outrank atmosphere here.

**Book reader:** the bar is not glass. It stands on a solid band of the current ground that fades out over its last 2rem, so a line of text never sits under the title. The floating surfaces (settings popover and sheet, the more menu, the contents drawer) share one reader surface: the light's solid glass fill (72–96% of a tone near the ground), `blur(28px) saturate(1.5)`, a 1px edge ring, a 1px inset top highlight, and the light's own lift shadow: black and deep on Gece and Loş, a soft brown on Sepya and a faint grey on Kağıt, so a light page is never stamped with a black shadow. The contents drawer opens over a 30% black scrim. Pressed segments and tabs lift on a hairline shadow (`0 1px 3px rgba(0,0,0,0.18)`) plus the edge ring.

### Shadow Vocabulary (Screening Room)

- **Cinematic Card** (`--shadow-cinematic-card`): rest state under posters and media cards.
- **Cinematic Card Hover** (`--shadow-cinematic-card-hover`): deeper, accent-tinted, on hover/focus.
- **Floating Panel** (`--shadow-floating-panel`): modals, overlays, the notification stack.
- **Artwork Glow** (`--shadow-artwork-glow`): large hero/backdrop art.
- **Player Controls** (`--shadow-player-controls`): floating playback chrome.
- **Button Glow** (`--shadow-button-glow`): primary calls to action.
- **Soft Inset** (`--shadow-soft-inset`): the subtle top/bottom inner highlight inside glass panels.

### Named Rules

**The Booth-Doesn't-Glow Rule.** Admin/operational surfaces never inherit glass blur, glow, or gradient decoration purely to match the browsing side. Shared identity there is carried by color, type, and shape — not by shadow.

**The Lift-Follows-The-Light Rule.** In the reader, every shadow, glass fill and edge comes from the current light's palette. A surface on Sepya or Kağıt never borrows the dark lights' black lift or a fixed white glass.

## Shapes

A two-radius grammar, applied without exception:

- **`rounded-full`** for every interactive control: icon buttons, pill buttons, segmented-toolbar items, chips, badges, progress dots. Nothing that a finger taps is ever a rectangle.
- **A small radius step for containers** — `8px` for standard buttons, `12px` for media cards and inputs, `16px` for larger panels and Control Booth cards.

There are no sharp corners anywhere in the system, and no radius values outside this scale.

The book reader follows this grammar for its controls (bar buttons, the action pill, segmented controls, tabs, count chips, slider tracks and the ruler marker are all fully round) and for its containers (16px settings popover, 12px theme swatches, face cards, chapter and bookmark rows). It also ships four off-scale radii that are drift, not a reader scale: the more menu at 14px and its items at 9px (they belong on 16px and 8px), the phone settings sheet's top corners at 22px, and book covers (drawer and loading) at 6px. The opener rule's 2px rounding is a line cap, not a container.

## Components

### Buttons

- **Shape:** `8px` radius (`rounded-lg`), never a pill except the hero/player CTAs, which intentionally step up to `rounded-full` as the most prominent calls to action in the room.
- **Primary:** Seyirlik Teal fill, near-black text, hover shifts to the lighter teal, focus ring in the accent, hover lifts `-1px`, press scales to `0.98`.
- **Secondary:** translucent white fill (`bg-white/10`) with a hairline border, brightens on hover.
- **Ghost:** transparent, fills translucent white on hover only.
- **Danger:** translucent fill with a rose border/text — deliberately not the same red used for critical system alerts.

### Cards / Containers

- **Media Card** (signature): `12px` radius, `aspect-[4/3]` (row) or portrait poster (grid), rests on `cinematic-card` shadow. Its metadata panel sits over a duplicated, blurred, mirrored copy of the artwork itself behind a black scrim — the panel appears to be made of the same image it's describing. A shimmer sweep (accent-tinted) fills the frame while art loads; a thin accent progress bar tracks continue-watching state along the bottom edge. On hover/focus: lifts, scales up slightly, and its border brightens from `white/10` to `white/20` — the shadow deepens to `cinematic-card-hover` at the same time.
- **Admin Card** (Control Booth signature): `16px` radius, hairline border, `bg-white/[0.03]` fill, `1rem`–`1.25rem` padding. Holds tabular stat rows (`tabular-nums`, `2xl`/`900` for the headline number) and small status dots (emerald/amber) rather than icons or imagery.

### Glass Controls (Screening Room signature)

Icon buttons, segmented toolbars, and pill inputs floated over media share one recipe: near-black translucent fill (`~75%` opacity), `backdrop-blur-2xl`, a one-pixel white hairline plus an inset top highlight and a soft drop shadow, brightening fill and shadow on hover, scaling down slightly on press. This is the system's one truly tactile control family — everything that lives on top of video or artwork uses it.

### Home Hero (signature)

The desktop home hero is a stage with its queue in view. Every featured title is one composition (artwork, legibility scrim, logo or condensed title) drawn at the stage's full size; the next three wait bottom-right as that same composition scaled into slots of the stage's own aspect ratio, 12px corners and a hairline that stay constant on screen at any scale. Miniatures show their artwork clean: the scrim fades in with scale as a title grows onto the stage, and nothing dims the queue. In a miniature the logo is drawn far larger than true to scale, bottom-left (7% in, 10% up, up to 40% × 21% of the frame), over a silhouette of itself: dark behind a logo lighter than the artwork, a light glow behind a darker one, stronger the lower their contrast (`src/lib/logoShadow.ts`, measured from small copies of both images). Between slot and stage the logo's place and size follow the frame's scale, so a lift carries it smoothly to its stage position, and the silhouette fades out as the frame grows. The artwork holds still on stage; there is no push-in. The logo and copy sit bottom-left, the actions level with the bottom of the queue, in fixed rows so the logo sits at the same height for every title. At rest the copy is only the facts line and the actions; the overview (three fixed lines) opens on request (the pointer resting on the title for 260ms, keyboard focus inside the copy, or the overview button among the actions, which pins it) and closes when the pointer leaves, when it is unpinned, or when the title changes. Every logo is drawn at the full width of its box, as tall as its own proportions make it (a wide logo is short, a near-square one tall, all on one baseline; only a logo that would reach the menu when fully open is held below it). It rests at 0.6× that, grown from its bottom-left corner so the artwork leads (0.46× while a trailer plays). Opening is one value driving every move, 0.32s, as quick as closing: the logo grows to full size and rises with the facts by the overview's height, while its text comes up from under them. While it is open the rotation clock stops. A change is always a move, never a swap: the chosen title grows out of its slot over the stage while the outgoing one recedes beneath it (scale 0.95, darkened), titles skipped over sink out, and the queue slides as one row on a single shared clock, the titles that stay closing up and newcomers lined up a slot apart beyond the right edge, so no miniature can overlap or pass another whichever slot was chosen. A lift takes the same time from every slot (0.5s base, sine in-out, lengthened only so no edge exceeds 84px per frame on a 1080-tall frame, about 0.51s in practice); the row slide is 0.45s (up to about 0.6s when the far miniature is chosen and three newcomers travel in). Going back reverses it. The first arrival has no opening effect. The loading skeleton (`src/components/home/HomeHeroSkeleton.tsx`, the page's usual shimmer and veils) is placed from the hero's own geometry, so each placeholder (logo box, facts, the four actions, the three slots, the progress track, the controls pill) has the size and position of what replaces it; the hero keeps it over itself until the first artwork is in, then it fades off as the artwork fades in, and the copy, queue and controls fade up where their placeholders were. Nothing moves in the hand-over. The facts and actions fade out as the next lift starts and fade back in as the title lands; they do not travel (`src/components/home/homeHeroModel.ts`); the accent appears only as the up-next progress line and focus rings; controls (previous, pause, next, position, trailer and sound when a trailer exists) sit in one glass pill above the queue. The actions (`src/components/home/HeroActions.tsx`) stand straight on the artwork, whose brightness nothing controls, so none of them is thin glass: play is solid white with a hairline edge and a soft falling shadow, and when there is progress it carries the time left and a progress line under its label; start over, details, My List and the overview are smoked glass (near-black at 66%, blurred, a hairline and inset highlight, a soft shadow below). Nothing clips their shadows, and each fades its own surface with the copy: a translucent parent would leave the glass with nothing to blur until the fade ended, and the blur would snap on after the title landed. There is no scrim behind the copy; the logo, facts line and overview carry their own legibility, measured from the artwork behind each (`src/lib/logoShadow.ts`): on stage the logo stands on a blurred halo of its own shape, and the white copy on a darker cloud of its letters, both a trace over a dark picture and full over a white sky, and the copy's shade is a filter so truncating and clamping never cut it into a rectangle. Along the stage's top edge, under the navbar only, lies a light black veil (`NavbarVeil`: 45% at the edge, eased out below the bar, within 144px, 108px under the shorter tablet bar); it belongs to the stage, not to a title, so it holds still while titles travel under it, and the wordmark measures its backdrop through it.

### Home Hero on a tall stage (tablet)

The tablet pages render the desktop's `HomeHero` and `TitleHero` themselves; nothing about them is a second implementation. What changes is the stage's shape, read from its own measurement (`heroForm` in `src/components/home/homeHeroModel.ts`): a stage taller than it is wide is laid out tall, so a tablet upright and a portrait desktop window get it, and a phone on its side gets the wide layout with smaller slots. On tablets the stage stands on the screen above the tab bar (`HERO_HEIGHT_CLASS.mobile`), so the actions are never under it. An upright phone (under 600px wide, `useIsPhoneView`) does not use this hero: it keeps its own (see "Phone heroes" below). The compact row described here is what a phone on its side or a narrow portrait window still gets.

- **Artwork follows the stage's shape** (`getStageImageCandidates`): a tall stage takes the poster, sharp and top-anchored, because it is drawn for that shape, a backdrop cut to a phone keeps a third of its width and would need twice the largest variant's height to stay sharp, and a poster's lettering usually sits low. An episode stands on its series' poster; a title with no poster falls back to the backdrop. Posters that print their title high (about a quarter of them) show it twice, lettering and logo; textless posters are the fix, not a cropped backdrop.
- **The foot:** over a poster the picture sinks into the void (`tallFootGradient`), eased across 40% of the stage and solid by the top of the logo's box, so the poster's printed title can never show behind the logo, facts or actions; the copy stands on the room, not the picture. Like the top scrim it fades in with the frame's scale: a miniature shows its poster whole.
- **Miniatures are posters as printed:** a poster carries its own lettering, so a miniature draws no logo. As it lifts, the foot fades the lettering away and the logo comes up after 35% of the way to the stage, so the two are never read together.
- **Layout, from the foot up:** the actions across the full width; the facts on the left, level with the foot of the queue on the right (three slots of the stage's own shape, 11% of its width), the up-next line under the head slot, the pill above the queue; the logo above the facts in the column the queue leaves (at most 60% of the width, and 2.6 times its box's height, so a tablet's logo is led by its taller stage), resting at full size (`TALL_TITLE_SCALE`): there is no pointer to rest on it and no room to grow into. A title page has no queue, so its facts and logo take the full width.
- **Compact actions** (stages under 600px wide): play stretches over whatever the round buttons leave and names only what it starts (an episode, or the verb; its accessible name stays the full label); Details is a round button; the time left gives way to the progress line under the label. A row never holds more than three round buttons: on the home hero start over waits for the title's page, and on a title page Details and the overview leave the row, because the page's details and its overview are directly below. Which controls a row holds is one function (`heroRowParts` in `HeroActions.tsx`) that the row and its skeleton both read. The pill on a phone holds pause and the position at a 44px touch size; previous and next stay in it for a keyboard and assistive technology, showing only while focused. While the overview is open the queue's layer is `inert`.
- **Swipe:** a horizontal drag on the stage moves it a fifth of the finger's travel (at most 44px), then either travels (56px, or a quick 24px flick) or settles back in 0.32s. Forward lifts the head of the queue, as a tap on it would; backward shrinks the stage back into the queue. A swipe that ends on a button is not a tap on it.
- **Overview:** the same single value as the desktop lifts the logo and facts by the overview's height while the three lines come up full width; the queue, its line and its pill fade out on the same value and take no taps while it is open.
- **Skeleton:** placed from the same geometry (`HomeHeroSkeletonPieces` reads `heroLayout`), at the same height class: logo box, facts, the compact or full row, the three slots, the up-next track and the pill, each where its piece lands. Once the title is known (the home hero waiting on its artwork, a title page waiting on its details) the row is reserved from that title: play sized by its own unseen label and time left, start over where it will be, one round per round button. Before then it assumes a fresh title. The mobile home page shows it before its data arrives; the mobile title page shows it with its back button and watched pill where the page puts them.

### Title Hero

A film's or series' own page opens on the home hero's stage with nothing queued (`src/components/home/TitleHero.tsx`): the same composition, top and bottom bands, logo sizing and halo, facts line, overview on request and actions, sharing the home hero's copy block (`src/components/home/HeroCopy.tsx`). There is no rotation and nothing travels; the trailer, when there is one, starts once after the artwork and copy have had their moment, never while the overview is open, and its controls sit alone in the glass pill at the right, level with the actions. "Details" scrolls to the details further down the page rather than linking to the page it is on. Its loading skeleton is the home hero's without the queue (`TitleHeroSkeleton`), with the page's back button, mark-watched pill and scroll chevron where the page puts them, so nothing moves when the page arrives. Tablet film and series pages use the same title hero on a tall stage (see above), with trailers off and no scroll chevron.

### Phone heroes

Phone poster cards (`MobileMediaCard`) draw a title's logo where the artwork tool placed it, as the desktop's `MediaCard` does, with its shadow scaled to the phone card's 150px; landscape tiles and titles never placed keep the logo at the card's foot. The navbar wordmark carries a soft dark shadow on every screen (`NavbarWordmark`), because over a hero the room behind it takes the artwork's colours, which can be the accent's own; over a desktop or tablet stage it takes only as much as the artwork behind its letters needs (`wordmarkShadowStrength`): none where the letters are already well darker than it, as dark teal on a bright sky, whose edge a black halo only smeared.

An upright phone keeps heroes of its own; the desktop's stage, cut to a phone, was tried in `29a0f53` and taken back. They speak the desktop hero's language (the title's logo, the facts line, a white play pill that resumes, glass round buttons) in the phone's own composition.

- **Home** (`src/components/mobile/PhoneHomeHero.tsx`): a deck of posters in a room lit by the front poster's own colours (the poster, blurred and saturated behind it). The front card is a poster card as the library draws it, only larger (2:3, 2rem corners, the cinematic card shadow and a hairline gradient edge): its logo stands where the artwork tool placed it (`LogoLayout`: centre, width and shadow as fractions of the card, the shadow scaled from the tool's 200px card to this one), and a title never placed there opens where the tool would open on it (`INITIAL_LOGO_LAYOUT`). Nothing else is drawn on the poster. The neighbours stand at each side at 88% and in 55% shade, lightening as they come forward; the front card is at most 70% of the screen wide, so both show, and is sized by the screen's height too (`CARD_WIDTH`), so the deck and everything under it stand above the tab bar down to a 667px-tall phone. A finger moves the whole deck one to one; on release it travels one card (past 18% of a card, or a flick of 0.35px/ms) or settles back, on a spring (stiffness 240, damping 30) that starts at the finger's own speed. A tap on a neighbour brings it forward; a tap on the front card opens the title. Under the deck, off the artwork: a 2px progress line in the accent (11s a card; it holds while a finger, a preview or pause has the deck, or the deck is out of view), the facts line (year · runtime · two genres), and play (stretching, naming only what it starts, with the progress line under "Devam Et"), My List and pause, in a lighter glass than the desktop's smoke (white 10% over a 16% hairline) because they stand on the room's dark foot. The copy crossfades in place as a card arrives, so its rows never empty. Where a title has a hero preview (`getHeroPreviewUrl`, the same source as the desktop's), it plays muted inside the front card 6s after the card comes to rest, once per visit, under the logo, with a sound button at the card's corner; its end moves the deck on. Previous and next exist for a keyboard and assistive technology, showing while focused.
- **Title pages** (`src/components/mobile/PhoneTitleHero.tsx`): the backdrop starts right under the navbar, so the wordmark and its icons stand on the room (over the picture they lost their edge on a bright one), and shows whole: the full width at its own 16:9, never cropped, and nothing dims it. Its edges are left hard: a fade into the room at top and bottom was tried, long and then short, and taken back both times. Two things stand on it: back, over its top-left corner, and the title's logo at its foot on the left, small (at most 2.75rem by 10.5rem, shrinking on a narrow phone so it never meets back), on the desktop stage's halo measured against the picture behind it (`logoShadowStyle.ts`); a title without a logo sets its name in Archivo 900 condensed with the cinematic text shadow. A title with no backdrop shows its poster whole on a blurred wash of itself. Under the picture, on the room, in rows of fixed height (`phoneTitleHeroRows.ts`): the facts line (year · runtime · two genres), three lines of overview, then play the full width (white, 50px) and under it the labelled actions. Under way, play names what it resumes (the verb, or a series' episode) and the time left after a dot in zinc-500, as the desktop's does, with the progress line across its foot; otherwise it names the verb and, for a series, the episode. The labelled actions have no surface, since they stand on the room: a 23px mark over a short name (Baştan when the title is under way, Listem, İzlendi, İndir on a film where offline works), each a column of equal width, at 74% white and full white while pressed (My List added, watched). The watched button belongs to the page's details, which hold whether the title is watched; on a phone they render it into the hero's slot (`watchedSlot`) instead of floating it over the picture. Over artwork, the navbar's icons carry the wordmark's soft shadow.
- **Skeletons:** `PhoneHomeHeroSkeleton` is built from the hero's own frame and card shell, its neighbours included, with the progress line, facts and three buttons in the same rows; `PhoneTitleHeroSkeleton` takes the title hero's rows in the same classes: the picture with the logo's box at its foot, the facts (sized by their own unseen words once the page has the title), the overview, play the full width, and one mark-over-name placeholder per labelled action, start over reserved where a film will show it. A series' next episode is not known until its continue list loads, so a series may still gain start over at hand-over.

### Notifications (signature)

A stack of glass chips (rounded, black/70, backdrop-blur) anchored bottom-right, collapsing into a pile with a mask-faded top/bottom edge rather than a hard-clipped scroll boundary. A balanced-ink spinner (two opposed arcs of equal weight) keeps its optical center still while it spins. Count badges are small pill chips in translucent white, heavy weight, tabular numerals.

### Book Reader (signature)

The reader (`src/pages/BookReaderPage.tsx`, `BookReaderPage.css`, `src/pages/reader/`) is one composition whose parts only make sense together.

- **Reading light** (`readingLight.ts`): the paragraph at the reading line (40% of the viewport) carries full ink, or, when the reader chooses Line, the line there; the text around it falls off to a floor: off (1, no light), soft (0.4, the default) or strong (0.16). Paragraph light falls off by the block's distance from the reading line on a smoothstep curve; line light falls off by each line's distance, centre to centre, from the lit line on an ease-out curve, so the lines beside it already step down and it reads as one line lit rather than a wash. Each has seven reaches, the distance at which it has fully fallen off as a share of the viewport, each about half as wide again as the last: paragraph 10, 20, 30 (default), 45, 70, 100, 150%; line 5, 10, 18 (default), 30, 50, 85, 150%; each shape keeps its own. The widest is a screen and a half, so the page is nearly evenly lit with the faintest peak at the reading line. A block carrying one even ink (every paragraph, and in line light every block the light is not stepping through) takes it as opacity. Only a block whose lines step takes an alpha mask, stepping at the middle of the leading between lines (measured from the text's line boxes when a block comes near the light), so every line carries one even ink and nothing is ever half-lit; a drop cap takes the brightest of the lines it stands in. A mask crops everything to the block's box, and a tightly set heading's ink stands above it (the dot of the İ in a BİR numeral), so a block set tighter than 1.15 × its own type is always lit whole, never masked. Ink fades over 0.35s (sine in-out) whenever the light moves. It changes only how much ink shows, never position or flow. A steady band (a fixed gradient mask on the scroller) was tried and removed: the text slid through a gradient and lines were half-lit.
- **Chapter ruler**: a 1px line in ink4 with 5px ticks in ink3 and longer 11px major ticks in ink2 (40 to 80 ticks, a major every tenth, so a short chapter still reads as a scale), captioned top and bottom with the current and next chapter in tracked Label caps (the current one in ink2); a 22 × 2px fully round marker in the live accent rides the line with the reading line, its percentage in tabular 0.6875rem ink2 to its left. It keeps that reading order on the right-hand side, names and ticks left of the line, rather than being mirrored. The marker moves linearly (0.12s) with the scroll; a leap (a new chapter in either direction, or more than a quarter of this one) never sweeps the length of the ruler: the marker fades out (0.18s), moves, and fades back in, and the chapter names, the scale and the time left crossfade with it.
- **Time left**: "Bölüm sonuna ≈ N dk", tracked Label caps in ink3 with the figure in ink2, tabular, right-aligned at the top of the margin. The estimate comes from epub.js locations (1,200 characters each) at 1,100 characters a minute; until the book is measured no estimate is shown rather than a guess.
- **Top bar and progress**: the back button alone at the left (no label), centred title (`reader-title`) over a tracked ink3 line of author · chapter, and a glass segmented pill of contents, bookmark, Aa and more at the right; the Aa pair is lifted 3.5px so its ink centres with the other icons. A 2px progress hairline in the live accent runs along the very top of the screen. The bar comes only when asked for: the pointer entering the top 4.5rem, a tap or click on the text that selects nothing, or keyboard focus. Any scroll sends it away (fade and 8px rise, 0.24s sine), and so does the pointer leaving it for 0.9s unless a panel is open or keyboard focus is inside; scrolling never brings it back.
- **Settings**: an anchored 23.25rem popover under the Aa button on desktop (scales up from 0.96 and drops 6px into place, 0.26s expo-out), a bottom sheet with a grab handle on phones (rises from below, 0.32s expo-out). Rows divided by hairlines: four theme swatches (each painted in its own light with an Aa specimen and edged with a 1px mid-grey at 28% (`rgba(127,127,127,0.28)`), the one edge that reads against both a dark and a light swatch on any panel; the chosen one ringed in ink with a 2px gap), two face cards (serif / sans), a size slider between a small and large A (ink-filled 4px track, white 20px thumb, an accent ring on focus), line spacing and width as three-step segmented controls, the reading light (strength off / soft / strong, and beneath it, a full-width line each, what it falls on, Paragraf / Satır, and its reach as seven icon steps (named by their percentage for assistive technology), each icon five rules dimmed as that reach would leave them; both rest at 45% and disabled while the light is off), and the margin (Kenar) as two independent switches, chapter ruler and time left: separate pills, each with its own dot (an inset ring when off, the live accent when on), so two "on" never reads as one unresolved choice; the ruler switch is hidden on phones, where there is no ruler. Every change applies live to the open book.
- **Contents drawer**: a left drawer (`min(25rem, 88vw)`, slides in at 0.3s expo-out over a 30% black scrim) headed by the cover, the book title in Headline and author, and a line of percent read · time left. Tabs (İçindekiler / Yer imleri, with a count chip) switch between chapters and bookmarks. Each chapter row is a condensed numeral, title, time, and a 4px bar of its length with how much has been read; the current row is tinted 6% ink, and its mark takes the accent: a numeral turns accent, an unnumbered row's 4px dot grows to 9px with a soft accent ring. Its read bar takes the accent too. There is no "you are here" label; the lit row says it. Bookmark rows show the excerpt in Literata (two lines) over a quiet place line.
- **Pending state**: until the book is measured the drawer keeps its rows' shapes, with ink4 pills where figures will be and an empty length bar, pulsing between full and 45% opacity every 1.6s. Nothing is estimated early.
- **Loading**: the cover (7.5rem, faded in) over a tracked Label line in ink3, centred on the ground.
- **Illustrations** (`ReaderImageViewer.tsx`): every picture in a book carries a zoom-in cursor and opens full size on a tap or click. It grows out of its own place in the text (whose copy steps aside while it is out) onto the reader's ground, which fades up to solid over the page; one sine in-out move, 0.36s, lengthened only so no edge exceeds 84px per frame on a 1080-tall window, and closing returns it to the same spot (or fades it where it is when that spot has scrolled away). Fitted, a picture fills the window less a 32px margin (12px on phones), enlarged at most 3× its own pixels; zoom goes no deeper than 4 CSS px per source pixel, so a small drawing already fitted large shows a zoom-out cursor and a tap puts it back. Tapping the picture zooms to 2.5× at that point and again to fit; pinch, ctrl-scroll (a trackpad pinch) and + / − / 0 zoom; drag or scroll pans, with a third of the pull past an edge; a fitted picture dragged down follows the finger while the ground thins, and goes home past 96px. Escape, a tap beside the picture or the round glass close button at the top right closes it. Pictures in the frame sit one layer above text (`position: relative; z-index: 1`), because the reading light gives each block its own layer and the paragraph beside a float would otherwise take its taps.
- **Motion**: two eases, a sine in-out (`cubic-bezier(0.37, 0, 0.63, 1)`) for fades and colour and an expo-out (`cubic-bezier(0.22, 1, 0.36, 1)`) for anything that travels; a theme change crossfades ground and ink over 0.32s; book blocks fade up 0.6rem over 520ms as they first render. Under reduced motion every transition and animation in the reader stops.

### Navigation

Clear at the top of the page. As the page scrolls the bar is lit like the top of a dark room rather than given a panel: the page's own black falls from the screen's top edge and thins on an eased curve to nothing 3rem below the bar (2.25rem on phones), with a light 14px blur behind the links only that is gone before the bar's foot, so nothing below the links is smeared and there is no edge, line or shadow (`src/components/NavbarSurface.tsx`). Scroll chooses between two complete states: the ceiling opens at 24px and closes at 8px, with a 300ms ease-out fade every time, including a reversal mid-flight. The gap between thresholds keeps small scroll movements from flickering the bar. Reduced motion uses a 120ms fade and removes the contents’ travel. Each layer fades itself, never their parent, which would become the blur's backdrop root and make it snap. A phone page with no artwork under the bar has the ceiling from the start. The contents still drop 8px while the bar is clear and rise as it fills. Language, notifications, downloads, administration, theme and logout live in the account menu, not in the bar; language is a two-way switch naming each language in its own name (Türkçe, English). Active link state is plain white text, not the accent color — Seyirlik Teal is reserved for hover/focus/progress signaling, never for "you are here."

## Do's and Don'ts

### Do:

- **Do** keep Seyirlik Teal rare: a glow, a fill, a ring, a dot — never a screen's dominant color (**The One Signal Light Rule**).
- **Do** build hierarchy from Archivo's weight, width, and letter-spacing (900 condensed for titles, 900 + tracked uppercase for labels) instead of introducing a second typeface (**The Weight-Not-Face Rule**).
- **Do** let Screening Room surfaces (browse, hero, player) carry real cinematic depth — layered shadow, glass blur, accent-tinted glow — proportional to how close the surface sits to the media itself.
- **Do** keep Control Booth surfaces flat, dense, and fast to scan: hairline borders, tabular numbers, minimal motion, no glow or blur (**The Booth-Doesn't-Glow Rule**).
- **Do** use `rounded-full` for every control the user taps or clicks, and the `8/12/16px` step scale for every container.
- **Do** take every reader colour, glass and shadow from the current light's palette, and measure a new light's ink3 at 4.5:1 or better on its own ground before it ships (**The Fourth-Step Ink Rule**).
- **Do** show reading position as a margin ruler, a percentage and an honest time left; when there is no margin, dock the time left at the foot rather than overlapping the column.
- **Do** set the book in Literata (or the reader's chosen sans) and everything around it in Archivo (**The Book-Face Boundary Rule**).
- **Do** handle Turkish by its text, not its declared language: uppercase with `text-transform` under `lang="tr"`, and soft hyphens from patterns (**The Turkish Casing Rule**).

### Don't:

- **Don't** let admin/operational UI inherit decorative cinema effects (glow, blur, gradients) merely to look "consistent" with the browsing side — Control Booth clarity outranks Screening Room polish there.
- **Don't** drift toward a generic self-hosted-dashboard or admin-template look: no Bootstrap-style boxed cards, arbitrary borders, blue-primary SaaS chrome, or dashboard chrome that exists for its own sake.
- **Don't** imitate another streaming product's exact layout, navigation, artwork treatment, typography, or interaction pattern (Netflix, Jellyfin, Plex) — Seyirlik is authored, not a clone of a category.
- **Don't** add a visual effect that doesn't earn its place through hierarchy, comprehension, feedback, or atmosphere — gratuitous gradients, glow, or glass; oversized empty spacing; decorative analytics for their own sake.
- **Don't** let dense technical/admin UI leak into the viewing experience, or let cinematic decoration leak into admin.
- **Don't** add page numbers, a page-count pill or a page-flip to the reader; the book is one continuous column and position is a ruler.
- **Don't** let the reading light move, scale or reflow text, or light part of a line; it lights whole paragraphs or whole lines and changes only how much ink shows.
- **Don't** add further accent uses to the reader beyond those recorded under Reader Lights; the recorded set is already one past the direction's four.
- **Don't** use a light or raised reader ground anywhere outside the reader shell (**The Reader-Scoped Light Rule**).
- **Don't** estimate time left before the book has been measured; show the pending shape instead.
