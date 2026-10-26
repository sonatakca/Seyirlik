"""A narration's working folder: everything needed to stop at any moment and go on later.

    <work>/script.json               the script being read
    <work>/takes/<chunk>/<fp>/<n>.wav  every take generated, kept for repairs
    <work>/chunks/<chunk>.json       the chosen take of a finished chunk
    <work>/sections/<n>.m4a          a finished section, and <n>.words.json beside it
    <work>/progress.json             the latest progress, for whoever is watching

A chunk is finished when its chunks/ file exists and names the same
fingerprint (text, voice, model): change any of them and it is read again.
Every file is written to a temporary name and renamed, so a crash leaves
either the old file or the new one, never half of one.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return None


class WorkDir:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def take_wav(self, chunk_id: str, fingerprint: str, take: int) -> Path:
        # Takes are kept per fingerprint: a take made with another voice or
        # other settings is never counted as one of this chunk's tries.
        path = self.root / "takes" / chunk_id / fingerprint / f"{take}.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def takes(self, chunk_id: str, fingerprint: str) -> int:
        folder = self.root / "takes" / chunk_id / fingerprint
        return len(list(folder.glob("*.wav"))) if folder.is_dir() else 0

    def chunk(self, chunk_id: str) -> Path:
        return self.root / "chunks" / f"{chunk_id}.json"

    def finished(self, chunk_id: str, fingerprint: str) -> dict | None:
        result = read_json(self.chunk(chunk_id))
        return result if result and result.get("fingerprint") == fingerprint else None

    def section(self, section: int, suffix: str) -> Path:
        path = self.root / "sections" / f"{section}{suffix}"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def progress(self) -> Path:
        return self.root / "progress.json"
