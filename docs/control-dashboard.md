# Control dashboard

Seyirlik Control is a small web dashboard for the server's configuration and
services: the two env files, the Windows services, the startup health report,
the drives, and the service logs. It runs on the server as its own Windows
service and is reachable **over Tailscale only**, from any device on the
tailnet — a laptop, a phone, the server itself.

```
http://<server's Tailscale address>:43200
```

## Why it is a separate service

The media server cannot be the thing that repairs the media server. The moment
someone most needs to change a setting is the moment the server cannot serve
an admin page: its media drive is missing and startup is stuck at _Media
storage_, or PostgreSQL is down and there is no admin login to check. So the
dashboard:

- is its own process, `SeyirlikControl`, with no dependency on the server, the
  worker, PostgreSQL, or the application's `node_modules`. It needs only Node.
- has its own password, not the site's admin login, which lives in the
  database.
- runs every disk check in a child process with a deadline, so a wedged drive
  costs a killed child rather than a hung dashboard.

The main server's configuration API stays read-only, as
`src/server/ownApi/system/configurationRoutes.ts` requires. Writing the env
files is this service's job, under a different account and on a different
network boundary.

## What it shows and edits

| Area     | What                                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview | The server's `/ownAPI/v1/health` report, phase by phase (a stuck phase shows its error and a shortcut to the setting), the managed services with start/stop/restart, every path setting with whether it exists and its free space, and the drives. |
| Settings | Every key in `settings.env` and `secrets.env`, grouped, validated, with history and restore.                                                                                                                                                       |
| Logs     | The end of each file in `C:\ProgramData\Seyirlik\logs`, optionally followed.                                                                                                                                                                       |
| Activity | Sign-ins, changes and service actions, with who (Tailscale address) and when.                                                                                                                                                                      |

### What can be seen

Visibility is decided per key, and fails closed (`control/lib/catalog.mjs`):

- **Visible** — paths, ports, modes, JSON configuration. Shown and edited as
  text. A URL inside a visible value still has its password and any key-like
  query parameter (`apikey=`, `token=`, …) blanked before it leaves the server.
- **Masked** — `DATABASE_URL` and the other database URLs show host, port,
  user and database, never the password. To change one, enter the whole URL.
- **Secret** — keys, passwords, the session and CSRF secrets. Never sent to a
  browser in any response. The dashboard only says whether one is set; it can
  be replaced or removed.

A key the catalogue does not know is secret if its name looks like a
credential (`…SECRET`, `…PASSWORD`, `…TOKEN`, `…API_KEY`, `…_KEY`, …) **or if
it is in `secrets.env`**. A credential cannot be saved into `settings.env`.

### Saving

Changes collect until _Review and save_, which shows each change in display
form (secrets as "new hidden value"), every validation error and warning, and
an option to restart `SeyirlikServer` and `SeyirlikWorker` afterwards. The
services read the env files only at startup, so a change without a restart has
no effect yet.

A path that does not exist is a warning, not an error: pointing the media root
at a drive that is about to be reconnected is legitimate.

## Failure model

- **Atomic.** A save writes a temporary file beside the target, flushes it,
  and renames it over the original. A crash leaves the old file or the new
  one. Leftover temporary files are removed when the service starts.
- **Permissions carried over.** `secrets.env` has its own ACL (the services
  may read that one file, not the folder). Before the rename, the original's
  DACL is copied onto the new file and checked; if that fails, nothing is
  saved.
- **No lost edits.** Every save names the version of the file it was based
  on. If the file changed in between — Notepad, a deploy script, a second
  tab — the save is refused with "changed since you loaded it", and nothing is
  written. Saves inside the dashboard are serialised.
- **Undoable.** The previous contents are kept in
  `C:\ProgramData\Seyirlik\control\history` before every write (40 per file),
  and any of them can be restored. A restore is itself kept, so it can be
  undone too. History of `secrets.env` contains old credentials, which is why
  that folder is readable only by SYSTEM, Administrators and the dashboard.
- **Audited.** `audit.jsonl` records which keys changed, never a value.

## Access

Three independent checks, any of which refuses a request:

1. **Network.** It listens on the Tailscale address and loopback only, the
   firewall rule admits only `100.64.0.0/10` on that address, and the service
   itself refuses any peer outside Tailscale's ranges.
2. **Host.** Requests must name this machine (its Tailscale address, MagicDNS
   name or hostname), which defeats DNS rebinding from a web page.
3. **Password.** scrypt-hashed in `control.json`; five failures from one
   address, or twenty overall, lock sign-in for 15 minutes. The session cookie
   is `HttpOnly; SameSite=Strict`, sessions end after two idle hours or twelve
   in total, and every request that changes something must carry a custom
   header that a cross-site form cannot send.

The service runs as its own virtual account, `NT SERVICE\SeyirlikControl`,
with modify on the two env files and their folders, its own data folder, read
on the logs, and query/start/stop on the three Seyirlik services. Nothing else.

## Install and update

On the server, as Administrator, from a checkout of this repository:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-control.ps1
```

It copies `control\` to `C:\Program Files\Seyirlik\control`, installs the
`SeyirlikControl` service under NSSM, applies the grants above, writes
`C:\ProgramData\Seyirlik\control\control.json`, adds the firewall rule, asks
for the password on first install, starts the service and checks it answers.

Run the same script to update. It keeps the password and refreshes the listen
address from Tailscale.

**Change or reset the password**, as Administrator on the server:

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\Program Files\Seyirlik\control\server.mjs' set-password --config C:\ProgramData\Seyirlik\control\control.json
```

It takes effect at the next sign-in; existing sessions end then.

**Remove it**:

```powershell
& 'C:\Program Files\Seyirlik\bin\nssm.exe' remove SeyirlikControl confirm
Get-NetFirewallRule -DisplayName 'Seyirlik Control (Tailscale)' | Remove-NetFirewallRule
Remove-Item -Recurse 'C:\Program Files\Seyirlik\control'
```

`C:\ProgramData\Seyirlik\control` holds the history and audit log; delete it
too if you no longer want them. The grants on the env files and services can
be left; they name an account that no longer exists.

## Development

On any machine, with simulated services and fake env files:

```bash
node control/dev-setup.mjs
node control/server.mjs set-password --config control/.dev/control.json
node control/server.mjs --config control/.dev/control.json
```

Then open `http://127.0.0.1:43200`. Tests: `npx vitest run control/`.
