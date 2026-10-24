# Release notes

Every release says what it changes. Before you ship, edit `release-note.json`
at the repository root:

```json
{
  "en": "Faster imports during encodes",
  "tr": "Kodlama sırasında hızlı içe aktarma"
}
```

- Two to five words in each language, at most 40 characters. The account menu
  shows it above the version hash, and the update button's tooltip shows the
  next release's note.
- Say what a viewer or the operator gets, in plain words: "Subtitles sync
  again", not "Fix offset bug in vttParser". Never a commit hash; the hash is
  already shown beside it.
- One note per ship. When a ship carries several commits, describe the most
  noticeable change.
- Commit the note with the change (or as its own commit), then run
  `deploy/ship.sh`. It refuses a release whose note is missing, has the wrong
  length, or is the one already live, and it prints the note it ships.

`scripts/check-release-note.ts` applies the same rule as the site
(`releaseNoteProblem` in `src/lib/appVersion/buildInfo.ts`), so you can check a
draft with:

```sh
node --import tsx scripts/check-release-note.ts < release-note.json
```

`deploy/ship.sh` itself is described at the top of the file, and the Windows
side in `docs/windows-deployment.md`.
