"""Narrates a script by hand:

    python -m seyirlik_narrator --script book.json --voice <voice dir> --work <work dir>
        [--section 1] [--blocks 71-90]

Stop it at any time; run the same command again to go on where it stopped.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .work import WorkDir


def blocks(spec: str) -> set[int]:
    first, _, last = spec.partition("-")
    return set(range(int(first), int(last or first) + 1))


def clock(seconds: float | None) -> str:
    if seconds is None:
        return "–"
    h, rest = divmod(int(seconds), 3600)
    return f"{h}h{rest // 60:02d}m" if h else f"{rest // 60}m{rest % 60:02d}s"


def main() -> int:
    parser = argparse.ArgumentParser(prog="seyirlik_narrator")
    parser.add_argument("--script", type=Path, required=True)
    parser.add_argument("--voice", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--section", type=int, action="append", help="only these sections")
    parser.add_argument("--blocks", type=blocks, help="only these blocks, e.g. 71-90 (with one --section)")
    args = parser.parse_args()

    script = json.loads(args.script.read_text("utf-8"))
    work = WorkDir(args.work)
    events = open(args.work / "events.jsonl", "a", encoding="utf-8")

    def report(event: dict) -> None:
        event = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **event}
        events.write(json.dumps(event, ensure_ascii=False) + "\n")
        events.flush()
        kind = event["type"]
        if kind == "progress":
            print(
                f"[section {event['section']}] {event['chunksDone']}/{event['chunksTotal']} chunks "
                f"({event['fraction']:.0%}) · {clock(event['audioSeconds'])} of audio · "
                f"{event['realTimeFactor'] or '–'}× real time · about {clock(event['etaSeconds'])} left",
                flush=True,
            )
        elif kind == "retry":
            print(f"  again: {event['chunk']} ({', '.join(event['reasons'])})", flush=True)
        else:
            print(f"  {kind}: {json.dumps(event, ensure_ascii=False)}", flush=True)

    from .models import Listener, Speaker, Voice
    from .narrate import Narration

    started = time.monotonic()
    voice = Voice.load(args.voice)
    speaker = Speaker(voice)
    listener = Listener()
    report({"type": "loaded", "seconds": round(time.monotonic() - started, 1)})

    narration = Narration(script, work, voice.fingerprint(), lambda: (speaker, listener), report)
    for section in script["sections"]:
        if args.section and section["section"] not in args.section:
            continue
        narration.run_section(section, args.blocks)
    return 0


if __name__ == "__main__":
    sys.exit(main())
