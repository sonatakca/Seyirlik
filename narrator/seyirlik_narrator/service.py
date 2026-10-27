"""The narrator as a service on the Mac: it asks the server for books to read
aloud, reads them, and uploads each section as soon as it is finished.

    python -m seyirlik_narrator.service connect --server https://playback.seyirlik.org
    python -m seyirlik_narrator.service install     start at login, keep running
    python -m seyirlik_narrator.service status
    python -m seyirlik_narrator.service run         what launchd runs
    python -m seyirlik_narrator.service uninstall

The key lives in the login keychain, never in a file. Everything read is kept
in the work folder, so stopping at any moment (a restart, the lid closed, the
network gone) loses nothing: the next run goes on where this one stopped.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import plistlib
import signal
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Callable

from .api import ApiError, Job, NarratorApi, Unreachable, file_sha256
from .work import WorkDir, read_json, write_json

SUPPORT = Path.home() / "Library" / "Application Support" / "Seyirlik Narrator"
CONFIG = SUPPORT / "service.json"
STATE = SUPPORT / "state.json"
LABEL = "org.seyirlik.narrator"
KEYCHAIN_SERVICE = "org.seyirlik.narrator"
AGENT = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"

# How often an idle narrator asks for work, and how long it waits out a server it cannot reach.
POLL_SECONDS = 60
RETRY_SECONDS = (15, 30, 60, 120, 300, 600)
# The server hands a book to another narrator after 15 minutes of silence.
HEARTBEAT_SECONDS = 60
# The speech models hold about 11 GB; an idle narrator gives them back by
# ending, and launchd starts it again (without them) at once.
IDLE_EXIT_SECONDS = 10 * 60


def log(message: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), message, flush=True)


# -- the key, in the login keychain -------------------------------------------

def store_key(server: str, key: str) -> None:
    subprocess.run(
        ["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", server, "-w", key],
        check=True, capture_output=True,
    )


def load_key(server: str) -> str | None:
    found = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", server, "-w"],
        capture_output=True, text=True,
    )
    if found.returncode != 0:
        return None
    return found.stdout.strip() or None


def load_config() -> dict:
    config = read_json(CONFIG)
    if not config:
        raise SystemExit("Not connected yet: run `python -m seyirlik_narrator.service connect --server <url>`.")
    return config


# -- reading one book ---------------------------------------------------------

class Lost(Exception):
    """The server no longer has this narrator reading the book: it was taken back or given away."""


class Reading:
    """One book, from its script to its last section, with the server kept informed."""

    def __init__(self, api: NarratorApi, job: Job, work: WorkDir, narrate: Callable[[dict, WorkDir, Callable[[dict], None], Job], None]):
        self.api = api
        self.job = job
        self.work = work
        self.narrate = narrate
        # Every key from the start: the heartbeat reads this while the reading changes it.
        self.report = {
            "fraction": 0.0, "sectionsDone": 0, "sectionsTotal": 0, "etaSeconds": None, "activity": "starting",
            # Where it is, for a person following a line asked for again.
            "section": None, "reading": [], "sent": None,
        }
        self.lost = False
        self._stop = threading.Event()
        # The heartbeat and the reading both report, and both write the state
        # file through the same temporary file: one at a time.
        self._sending = threading.Lock()

    def _send(self) -> None:
        with self._sending:
            try:
                self.api.progress(self.job.item_id, self.report)
            except ApiError as error:
                if error.code == "NARRATION_NOT_HELD":
                    self.lost = True
            except Unreachable:
                pass  # said again at the next beat
            write_json(STATE, {"itemId": self.job.item_id, "at": time.time(), **self.report})

    def _beat(self) -> None:
        # The server hears from the narrator even while one long step (a model
        # loading, an hour of audio encoding, an upload) says nothing itself.
        while not self._stop.wait(HEARTBEAT_SECONDS):
            self._send()

    def _set(self, **changes) -> None:
        self.report.update(changes)
        if self.lost:
            raise Lost()

    def run(self) -> None:
        beat = threading.Thread(target=self._beat, daemon=True)
        beat.start()
        try:
            self._run()
        finally:
            self._stop.set()
            # Nothing reports for this book once its reading has returned.
            beat.join()

    def _run(self) -> None:
        script = self.api.script(self.job.item_id)
        write_json(self.work.root / "script.json", script)
        sections = script["sections"]
        weights = [sum(len(b["text"]) for b in s["blocks"]) for s in sections]
        total = sum(weights) or 1
        self._set(sectionsTotal=len(sections), activity="reading")
        self._send()

        for index, section in enumerate(sections):
            number = section["section"]
            before = sum(weights[:index])
            audio = self.work.section(number, ".m4a")
            words = self.work.section(number, ".words.json")
            have = self.job.uploaded.get(number)

            def progress(event: dict, before: int = before, weight: int = weights[index], number: int = number) -> None:
                kind = event.get("type")
                if kind == "progress":
                    # A batch is done: its lines are no longer being read.
                    self._set(
                        fraction=round((before + event["fraction"] * weight) / total, 4),
                        etaSeconds=event.get("etaSeconds"),
                        activity="reading",
                        section=number,
                        reading=[],
                    )
                elif kind in ("loading", "speaking", "assembling"):
                    # Said at once: each is a step a person may be waiting through.
                    self._set(
                        activity={"loading": "loading", "speaking": "reading", "assembling": "assembling"}[kind],
                        section=number,
                        reading=event.get("chunks", []),
                    )
                    self._send()

            self._set(section=number, reading=[], sent=None)
            # Reads only what the section still needs: nothing, when the book
            # was asked for again because of a line in another section.
            self.narrate(section, self.work, progress, self.job)
            sha = file_sha256(audio)
            check = self.work.section(number, ".check.json")
            try:
                if sha != have:
                    self._set(activity="uploading", reading=[], sent=0.0)
                    self._send()

                    def sent(fraction: float) -> None:
                        self._set(sent=round(fraction, 4))
                        self._send()

                    self.api.upload_section(self.job.item_id, number, audio, read_json(words), sent)
                    log(f"section {number} uploaded ({index + 1}/{len(sections)})")
                if check.exists() and self.job.checked.get(number) != sha:
                    self.api.upload_check(self.job.item_id, number, sha, read_json(check))
            except ApiError as error:
                if error.code == "NARRATION_NOT_HELD":
                    raise Lost() from None
                raise
            self._set(
                sectionsDone=index + 1, fraction=round((before + weights[index]) / total, 4), activity="reading", sent=None
            )
            self._send()

        try:
            self.api.finish(self.job.item_id, ready=True)
        except ApiError as error:
            if error.code == "NARRATION_NOT_HELD":
                raise Lost() from None
            raise
        with self._sending:
            self.report.update(fraction=1.0, activity="done", etaSeconds=0, section=None, reading=[], sent=None)
            write_json(STATE, {"itemId": self.job.item_id, "at": time.time(), **self.report})


# -- the service ----------------------------------------------------------------

class Narrator:
    """Loads the speech models the first time a book needs them, and keeps them while books keep coming."""

    def __init__(self, voice_dir: Path):
        self.voice_dir = voice_dir
        self.models = None

    def _load(self, progress: Callable[[dict], None] | None = None):
        from .models import Listener, Speaker, Voice

        if self.models is None:
            log("loading the speech models")
            if progress:
                progress({"type": "loading"})
            self.models = (Speaker(Voice.load(self.voice_dir)), Listener())
        return self.models

    def __call__(self, section: dict, work: WorkDir, progress: Callable[[dict], None], job: Job) -> None:
        from .models import Voice
        from .narrate import Narration

        script = read_json(work.root / "script.json")
        # The models load only once a chunk has to be read: a section with
        # nothing new in it (the book was asked for again for another one) is only checked.
        narration = Narration(
            script, work, Voice.load(self.voice_dir).fingerprint(), lambda: self._load(progress), progress,
            pronunciations=job.pronunciations, retakes=job.retakes,
        )
        narration.run_section(section)


def serve(api: NarratorApi, voice: str, voices: Path, work_root: Path, narrate=None, once: bool = False) -> None:
    voice_dir = voices / voice
    if not (voice_dir / "voice.json").is_file():
        raise SystemExit(f"The voice {voice!r} is not in {voices}.")
    narrate = narrate or Narrator(voice_dir)
    idle_since = time.monotonic()
    failures = 0
    while True:
        try:
            job = api.claim(voice)
            failures = 0
        except Unreachable as error:
            wait = RETRY_SECONDS[min(failures, len(RETRY_SECONDS) - 1)]
            failures += 1
            log(f"{error}; asking again in {wait} s")
            time.sleep(wait)
            continue

        if job is None:
            if once:
                return
            if getattr(narrate, "models", None) is not None and time.monotonic() - idle_since > IDLE_EXIT_SECONDS:
                log("no books waiting: ending to give the speech models' memory back")
                return
            time.sleep(POLL_SECONDS)
            continue

        log(f"reading {job.item_id} in {job.voice}")
        reading = Reading(api, job, WorkDir(work_root / job.item_id), narrate)
        # Awake while reading: an idle Mac would sleep in the middle of a book.
        awake = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())]) if sys.platform == "darwin" else None
        try:
            reading.run()
            log(f"finished {job.item_id}")
        except Lost:
            log(f"{job.item_id} is no longer this narrator's to read; stopping it")
        except Unreachable as error:
            # Everything read is kept: the next claim gives this book back and goes on.
            log(f"lost the server while reading ({error}); going on when it answers")
            time.sleep(RETRY_SECONDS[0])
        except Exception as error:  # the book cannot be read: say so, rather than trying it forever
            if isinstance(error, ApiError) and error.code == "NARRATION_NOT_HELD":
                log(f"{job.item_id} is no longer this narrator's to read; stopping it")
                continue
            log(traceback.format_exc())
            try:
                api.finish(job.item_id, ready=False, error=f"{type(error).__name__}: {error}"[:2000])
            except (ApiError, Unreachable):
                pass
        finally:
            if awake:
                awake.terminate()
        idle_since = time.monotonic()
        if once:
            return


# -- commands -------------------------------------------------------------------

def connect(args) -> None:
    server = args.server.rstrip("/")
    key = getpass.getpass("Narrator key (from scripts/narrator-key.ts create): ").strip()
    hello = NarratorApi(server, key).hello()
    store_key(server, key)
    write_json(CONFIG, {"server": server, "voice": args.voice})
    print(f"Connected to {server} as {hello['label']}. Voice: {args.voice}.")


def run(args) -> None:
    config = load_config()
    key = load_key(config["server"])
    if not key:
        raise SystemExit("The narrator key is not in the keychain: run connect again.")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log(f"narrator for {config['server']} in {config['voice']}")
    serve(NarratorApi(config["server"], key), config["voice"], SUPPORT / "voices", SUPPORT / "work")


def install(args) -> None:
    load_config()
    logs = SUPPORT / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    agent = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, "-m", "seyirlik_narrator.service", "run"],
        # This checkout: move it and the agent must be installed again.
        "WorkingDirectory": str(Path(__file__).resolve().parent.parent),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 30,
        "EnvironmentVariables": {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONUNBUFFERED": "1"},
        "StandardOutPath": str(logs / "service.log"),
        "StandardErrorPath": str(logs / "service.log"),
    }
    AGENT.parent.mkdir(parents=True, exist_ok=True)
    with open(AGENT, "wb") as f:
        plistlib.dump(agent, f)
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", f"{domain}/{LABEL}"], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(AGENT)], check=True)
    print(f"Installed: the narrator starts at login. Its log: {logs / 'service.log'}")


def uninstall(args) -> None:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    AGENT.unlink(missing_ok=True)
    print("Uninstalled. The key stays in the keychain and the work folder stays; remove them by hand if you want.")


def status(args) -> None:
    config = load_config()
    key = load_key(config["server"])
    print(f"Server: {config['server']}  voice: {config['voice']}  key: {'in the keychain' if key else 'missing'}")
    loaded = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], capture_output=True).returncode == 0
    print(f"Service: {'running under launchd' if loaded else 'not installed'}")
    if key:
        try:
            print(f"Signed in as: {NarratorApi(config['server'], key).hello()['label']}")
        except (ApiError, Unreachable) as error:
            print(f"Signed in as: no ({error})")
    state = read_json(STATE)
    if state:
        ago = int(time.time() - state["at"])
        print(f"Last book: {state['itemId']}, {state['fraction']:.0%} read, {state['activity']} ({ago} s ago)")


def main() -> None:
    parser = argparse.ArgumentParser(prog="seyirlik_narrator.service")
    commands = parser.add_subparsers(dest="command", required=True)
    joined = commands.add_parser("connect", help="sign in to a server with a narrator key")
    joined.add_argument("--server", required=True)
    joined.add_argument("--voice", default="mk")
    for name, handler in [("run", run), ("install", install), ("uninstall", uninstall), ("status", status)]:
        commands.add_parser(name).set_defaults(handler=handler)
    joined.set_defaults(handler=connect)
    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
