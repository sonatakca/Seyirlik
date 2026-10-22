---
version: 1
slug: "src-components-home-homehero-tsx"
primary_target: "src/components/home/HomeHero.tsx"
related_targets:
  [
    "src/pages/desktop/DesktopHomePage.tsx",
    "src/pages/mobile/MobileHomePage.tsx",
    "src/components/home/TitleHero.tsx",
    "src/pages/mobile/MobileLibraryPage.tsx",
    "src/components/home/HomeHeroSkeleton.tsx",
  ]
---

# Home hero (every device)

Scope: the home hero and its carousel, and the title hero it lends to film and series pages, on desktop, tablet and phone, with their loading skeletons. Mode: Experience inside the Screening Room (Operate affordances intact: play, details, save, rotation control). The tablet pages render the same components as the desktop, the stage's shape picking the layout; an upright phone keeps its own poster-card home hero and `PhoneTitleHero` title pages (DESIGN.md, "Phone heroes").

## Direction contract

THESIS: A stage with its queue in view. Every featured title is one composition that is either on stage or waiting as its own miniature; every change is that composition physically travelling between the two. Refuses the category default: a backdrop crossfade over dot indicators.

OWN-WORLD: Screening Room void; the film's own artwork is the only colour; logo or Archivo 900 condensed title; glass rounded-full controls; accent only as the up-next progress line and focus.

STORY: What is on, what is next, and when it changes. Play, details, save, jump to any queued title, hold the rotation.

FIRST VIEWPORT: Full-bleed backdrop; logo lower-left near 34vw; facts, three-line overview, actions beneath; three miniatures bottom-right, the first carrying its progress; controls beside them.

TALL STAGE (tablet upright, any portrait window wider than a phone): the stage ends at the tab bar; the poster fills it, top-anchored, sinking into the void, solid by the top of the logo's box, so its printed lettering never shows behind the copy; the actions span the foot; above them the facts (left) share a row with the queue (right), the pill above the queue; the logo rests full-size in the column the queue leaves. Swipe moves the stage (it gives under the finger first); the overview opens across the queue's row and the queue steps aside for it. A phone's row is compact and never holds more than three rounds: play stretches, Details turns round, start over waits for the title page at home, and on a title page Details and the overview stay home (the page below has both).

FORM: code-led section in an established world; no seed roll (section scope).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Approved floating hero (October 9, 2026)

The reviewed centre-dock prototype is the authority for this revision. Frame the
clean artwork with an 8px top margin, 16px side/bottom margins and 16px corners. Desktop keeps two larger
16:9 previews; landscape tablet keeps one preview at the dock's 102px height
and uses the backdrop's 16:9 band. Play occupies the dock's top floor and
labelled Details, My List and Overview occupy its lower floor. Preserve resume,
start over, watched and offline actions where applicable.

Logo, facts and overview share a 240ms sine-in-out clock, with immediate pointer
leave collapse. On a phone title page, centre the logo below the unshaded artwork
with 16px top padding. Mirror the backdrop across its bottom edge, blur 30px at
60% opacity behind the complete copy, and keep 24px below the description. The
card has 16px side margins and rounded top and bottom corners. The back control
sits evenly inside its top-left corner, a 38px visible circle in a 44px target.


Follow-up: add a silver hairline to the floating artwork, remove the top navbar
vignette while retaining individual logo/link shadows, and keep visible corner
radii between 12px (preview) and 16px (stage) throughout carousel travel. Fade the
centre dock as one surface, including glass and controls. Separate labelled
lower actions by 4px, show the translated short restart label, and wrap overflow
actions rather than truncate them.

Restart owns a full third level directly below Play/Continue when available;
the remaining actions follow below. Without restart, keep two levels. Trailer
and sound controls appear to the left of the right-anchored carousel controls,
so Previous/Pause/Next never move when those optional controls change.
