# Release decisions

How Seyirlik reads a release, decides whether it is any good, and picks one.
Discovery is [indexer search](./indexer-search.md); this is what happens to
what it finds. Nothing here acquires anything.

## Layers

```
parseRelease     what a title appears to describe — facts only
quality          those facts as a (source × resolution) pair
qualityProfile   what the user wants, and whether a candidate satisfies it
preferences      composable rules that score what quality cannot express
decide           which candidate wins, and why each other one did not
monitoring       what is being watched for, and what is therefore wanted
```

The split between the first and the third is the important one. `2160p WEB-DL
HEVC Atmos` is a fact. Whether that beats `1080p BluRay AVC` is an opinion, and
it belongs to a profile. Mixing them would mean the parser changed every time
somebody's preferences did.

## Reading a title

A release name is written by a stranger to no standard, so two rules run
through the parser.

**The longest token wins.** `DTS-HD MA` is not `DTS`, `HDR10+` is not `HDR10`,
`WEB-DL` is not `WEB`. An explicit line count also beats a loose one: `Hybrid
1080p UHD BluRay` is a 1080p encode from a UHD source, and calling it 2160p
offers it to a profile that asked for 4K.

**Silence is not evidence.** A title that never mentions HDR gets an empty
list, not `SDR`. A fact invented here is one no later layer can distinguish
from one the release actually claimed.

Two consequences of scene separators being interchangeable are worth knowing,
because each was a fact silently lost: `DDP5.1` tokenizes to `DDP5 1`, so there
is no word boundary after the codec or before the channel count; and `REPACK2`
has none after the K.

The year is the **last** year-shaped token before the metadata, bounded by next
year. `Blade Runner 2049` and `2012` are both films whose names end in
something that looks exactly like a year, and reading left to right gets both
backwards.

## Quality and profiles

Quality is a source and a resolution chosen independently — `webdl-1080p`,
`remux-2160p` — because that is how the profiles being replaced are already
written, and one flat enum cannot express "any 2160p" without listing every
member.

Ranking lives in the profile, not in a global table: the profile lists its
qualities worst-first, and a position may hold several at once. Upgrades
default **off**, because every profile being replaced has them off and an
upgrade is a second download and a second import of something already held.

Every verdict carries reasons. `quality-allowed`, `cutoff-met`,
`upgrades-disabled`, and so on — a number alone cannot answer the question an
operator actually asks.

## Preferences

Composable rules, each producing match / score / reason. Conditions ask about
enumerated facts (codec, source, resolution, HDR, audio, edition, language,
group, streaming service, flags) or plain case-insensitive substrings.

**There is no regular-expression condition, deliberately.** A saved pattern
runs against every candidate of every future search, so one that backtracks
catastrophically stalls the process; a timeout would still mean executing a
stranger's program. A rule with no conditions matches nothing rather than
everything, and an empty substring matches nothing rather than every title.

Rules that did not match stay in the trail with a zero contribution:
considered-and-declined is a different thing from absent.

## Choosing

Candidates are ranked by a ladder, each rung defensible on its own:

1. **accepted** — a rejected candidate can never win
2. **profile rank** — the user said which quality they wanted
3. **preference score** — then what they said they like
4. **revision** — a PROPER exists only because the first attempt was broken
5. **intrinsic quality** — separates qualities the profile grouped together
6. **size** — at identical quality, more bits is less compression
7. **identifier** — so the answer is stable when nothing else distinguishes

The last rung is the point. An indexer returns results in whatever order it
likes, and a comparison returning 0 for two genuinely different releases would
quietly hand the choice to that order. The engine asserts it never returns 0
for different releases, in both directions.

Rejections are explicit and nothing is dropped: `title-mismatch`, `wrong-year`,
`wrong-season`, `wrong-episode`, `wrong-kind`, `quality-not-allowed`,
`quality-unknown`, `below-format-score`, `incomplete-pack`,
`upgrade-not-wanted`.

A whole series is a target of its own (`kind: "series"`, no season). It takes
a release that names its seasons as packs (`S01-S10`) and holds every season
still missing, or one that names none and says it is complete. One season, an
episode, or a release that names no season and does not say so is refused. A
pack of either kind that calls itself incomplete is refused as
`incomplete-pack`: taking it stops the episode search that would have filled
its gaps.

A year may differ by one — a December release is routinely tagged with the
following year by one indexer and the previous by another. Two years apart is a
different film.

## Monitoring

Series monitoring is a boolean. Season and episode monitoring is **tri-state**:
`inherit`, `monitored`, `unmonitored`.

Three independent booleans cannot express a monitored episode inside an
unmonitored season inside a monitored series: whichever way the code resolves
it, the row does not record whether the season was _chosen_ unmonitored or
merely inherited it. `inherit` says the level has no opinion, so precedence
lives in the data rather than in whoever reads it. Resolution walks up from the
most specific opinion and reports which level decided.

An unknown air date means unknown; a future one means the episode cannot be
missing yet. Otherwise every future episode of every monitored series joins the
wanted list the moment the series is added.

A want says _why_ something is wanted — `missing`, `below-cutoff`,
`not-monitored`, `no-profile`, `not-yet-aired`, `satisfied`. A download in
flight is a different record with a different lifetime, and belongs to a later
phase.

## API

Administrator-only.

| Route                               | Does                                           |
| ----------------------------------- | ---------------------------------------------- |
| `GET /ownAPI/v1/releases/profiles`  | the configured quality profiles                |
| `POST /ownAPI/v1/releases/evaluate` | search for a target and judge everything found |

`evaluate` takes `kind` (`movie`/`season`/`episode`), `title`, and `year` or
`season`/`episode`, plus `profileId` and optionally `indexerIds`, `limit`,
`currentQualityId`, `currentFormatScore`. It returns every candidate with its
verdict, score and reasons, plus the winner — or `null`, rather than an
invented one.

**The title is resolved before it is searched.** Indexers match words, and
releases carry original or English names: NZBgeek finds nothing for
"Kara Şövalye" or for "Joker: Folie à Deux", and a hundred releases for
"The Dark Knight" and "Joker Folie a Deux". So the typed title is looked up on
TMDB in Turkish and in English at once (`titleIdentity.ts`), or taken from an
optional `tmdbId` when the linking page already knows it. A film is then
searched by its IMDb id; failing that, or for a series, by its English, then
original, then typed name, folded to plain letters with punctuation removed.
Every name the title goes by is accepted when a release is matched to it. The
response says what happened — `resolved` (or `null`, searched as typed),
`alternatives` (other titles the same words could mean, offered rather than
chosen) and `searchedFor`. Without TMDB, or when TMDB fails, the folded typed
title is searched as before.

It is called **evaluate**, not grab. There is no route here that fetches an NZB
or hands one to a download client; releases reach a client only through a
conversion with no field for the credential-bearing download URL.

## Storage

Migration `020_acquisition_policy` adds `quality_profiles`,
`preference_rules`, `quality_profile_preferences`, `monitored_items`,
`monitored_seasons` and `monitored_episodes`.

A rule's score lives on the profile/rule pairing, not on either side: the same
`x265 HEVC` rule is worth 100 to one profile and 0 to another.

Search candidates are **not** stored. They are evaluated and discarded; a table
of them would grow with every search and answer no question the indexer cannot
answer again.
