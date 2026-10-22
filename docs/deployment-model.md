# Deployment and update

How a version of Seyirlik gets onto the Windows host, and the ordering that
must not be got wrong.

## The invariant

```
the database's schema must be current
        BEFORE
code that requires it is activated
```

Both services validate the schema at startup and refuse to run against a stale
one. That refusal is correct — a server running against a schema it does not
understand is worse than one that will not start — but it means activating new
code before migrating turns a deployment into an outage. This is not
hypothetical: it is what happened in Phase 7.

The corollary is less obvious and equally binding: **the migration must be run
by the new version's code**, because it is the new version that ships the
migration files. Running the old code's migrator cannot apply a migration it
does not have.

## Where the application lives today

`C:\SeyirlikValidation\phase-0b-20260907-215500\candidate` — a validation-era
path, running from a git checkout, with `node --import tsx` as the service
entry point. It works, and every part of it is wrong for a product:

- the path names a validation run and a date
- production is a working tree, so a stray edit is a production edit
- `tsx` compiles on every start
- there is no second copy to roll back to

## The intended shape

Versioned, immutable release directories with a pointer:

```
C:\ProgramData\Seyirlik\app\
  releases\
    2026.09.09-1\        one build, never edited after it is written
    2026.09.09-2\
  current -> releases\2026.09.09-2     (a junction the services resolve)
```

Configuration and secrets stay where Phase 1 put them
(`C:\ProgramData\Seyirlik\config`, `...\secrets`) and are never inside a
release, so a rollback cannot take configuration backwards with it.

## The update sequence

Each step is ordered so that failing at it leaves the previous version serving.

```
1  stage      write the new release directory; the running one is untouched
2  verify     it starts far enough to answer, against a scratch database
3  backup     pg_dump, plus the two environment files
4  migrate    run the NEW release's migrator against the live database
5  verify     schema reports current, with no pending migrations
6  switch     repoint `current` — one rename, and the only irreversible step
7  restart    worker first, then server
8  health     alive, ready, and every core check available
9  roll back  on failure at 7 or 8: repoint `current`, restart, restore
```

Steps 1 to 5 change nothing an operator would notice. If step 5 says the schema
is not current, the update stops there with the old version still serving.

**Migrations are additive across a rollback.** Step 9 restores the code, not the
schema: a rolled-back release runs against a schema newer than it shipped, which
is why a migration must never remove or rename what the previous version reads.
Where that cannot be avoided, the change takes two releases — one that adds and
one that removes, with a version serving in between.

## What is already here

- `readSchemaState` reports applied, latest, current and pending, from
  `seyirlik_migrations`. It is the check step 5 makes.
- `/admin/schema` shows it to an operator, naming the missing versions rather
  than counting them.
- `validateMigrationsApplied` is the refusal the services already make.

## What is deliberately not built yet

The relocation itself. Moving the live application is the one step with no
rehearsal available on this host, and doing it while the expansion drive is
still unimaged would stack two risky changes. The design above is written down
so the move is a decision about timing rather than about design; a self-updater
that could strand the machine half-switched is explicitly out of scope.
