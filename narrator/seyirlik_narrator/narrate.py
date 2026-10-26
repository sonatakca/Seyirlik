"""Reads a script aloud, section by section, keeping every finished chunk.

For each chunk: generate a take, hear it, time its words, and judge it. A take
that skipped words, ran long or garbled a word is tried again, up to
MAX_TAKES; the best one is kept either way, and the chunk is marked for a
person to review if none was accepted. When a section's chunks are all done,
its takes are joined with the pauses the text asks for, and every word gets
its time in the section's recording.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from .align import time_words
from .assemble import Piece, encode_m4a, join
from .models import HIGGS, Listener, Speaker
from .text import Chunk, chunk_section, tts_text
from .verify import Verdict, judge
from .work import WorkDir, read_json, write_json

ENGINE = "seyirlik-narrator/1"
MAX_TAKES = 3
BATCH = 4

Report = Callable[[dict], None]


def fingerprint(chunk: Chunk, voice: dict) -> str:
    key = json.dumps({"engine": ENGINE, "model": HIGGS, "voice": voice, "text": tts_text(chunk.text)}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(key.encode()).hexdigest()[:24]


class Narration:
    def __init__(self, script: dict, work: WorkDir, speaker: Speaker, listener: Listener, report: Report):
        self.script = script
        self.work = work
        self.speaker = speaker
        self.listener = listener
        self.report = report
        self.voice = speaker.voice.fingerprint()
        self.started = time.monotonic()
        self.generated_seconds = 0.0  # audio made by this run, for its speed
        self.generated_chars = 0

    # -- one take -------------------------------------------------------------

    def _analyse(self, chunk: Chunk, print_: str, take: int, audio: np.ndarray) -> dict:
        rate = self.speaker.sample_rate
        wav = self.work.take_wav(chunk.id, print_, take)
        sf.write(wav, audio, rate, subtype="PCM_16")
        seconds = len(audio) / rate
        timed = []
        if seconds > 0.2:
            try:
                timed = time_words(self.listener.log_probs(audio, rate), chunk.words, self.listener.vocab, self.listener.separator, self.listener.blank)
            except ValueError:  # far too short for its words: the verdict says so below
                timed = []
        heard = self.listener.hear(audio, rate) if seconds > 0.2 else ""
        verdict = judge(chunk.text, heard, timed, seconds)
        if not timed:
            verdict.rate_ok = False
        result = {
            "take": take,
            "seconds": round(seconds, 3),
            "verdict": asdict(verdict),
            "words": [[w.start, w.end, w.t0, w.t1, w.confidence] for w in timed],
        }
        write_json(wav.with_suffix(".json"), result)
        return result

    @staticmethod
    def _verdict(result: dict) -> Verdict:
        return Verdict(**result["verdict"])

    # -- a section ------------------------------------------------------------

    def run_section(self, section: dict, only_blocks: set[int] | None = None) -> None:
        chunks = [c for c in chunk_section(section) if only_blocks is None or c.block in only_blocks]
        prints = {c.id: fingerprint(c, self.voice) for c in chunks}
        done = {c.id for c in chunks if self.work.finished(c.id, prints[c.id])}
        pending = [c for c in chunks if c.id not in done]

        # Takes already made before a stop count toward a chunk's tries; one
        # that was saved but not yet judged is judged now, not made again.
        tries: dict[str, list[dict]] = {}
        for c in pending:
            tries[c.id] = []
            for n in range(1, self.work.takes(c.id, prints[c.id]) + 1):
                wav = self.work.take_wav(c.id, prints[c.id], n)
                result = read_json(wav.with_suffix(".json"))
                if result is None:
                    audio, _ = sf.read(wav, dtype="float32")
                    result = self._analyse(c, prints[c.id], n, audio)
                tries[c.id].append(result)
            if tries[c.id] and (self._verdict(tries[c.id][-1]).accepted or len(tries[c.id]) >= MAX_TAKES):
                self._finish(c, prints[c.id], tries[c.id])
                done.add(c.id)
        pending = [c for c in pending if c.id not in done]

        total_chars = sum(len(c.text) for c in chunks)
        done_chars = sum(len(c.text) for c in chunks if c.id in done)
        self._progress(section["section"], len(done), len(chunks), done_chars, total_chars, "generating")

        # Similar lengths in one batch: a batch runs as long as its longest take.
        queue = sorted(pending, key=lambda c: len(c.text))
        while queue:
            batch, queue = queue[:BATCH], queue[BATCH:]
            audios = self.speaker.say([tts_text(c.text) for c in batch])
            for chunk, audio in zip(batch, audios):
                result = self._analyse(chunk, prints[chunk.id], len(tries[chunk.id]) + 1, audio)
                tries[chunk.id].append(result)
                self.generated_seconds += result["seconds"]
                self.generated_chars += len(chunk.text)
                if self._verdict(result).accepted or len(tries[chunk.id]) >= MAX_TAKES:
                    self._finish(chunk, prints[chunk.id], tries[chunk.id])
                    done.add(chunk.id)
                    done_chars += len(chunk.text)
                else:
                    queue.append(chunk)
                    self.report({"type": "retry", "chunk": chunk.id, "reasons": self._verdict(result).reasons()})
            self._progress(section["section"], len(done), len(chunks), done_chars, total_chars, "generating")

        # A trial run over some blocks makes a recording of just those.
        self.assemble(section, chunks, prints)

    def _finish(self, chunk: Chunk, print_: str, takes: list[dict]) -> None:
        best = max(takes, key=lambda r: self._verdict(r).rank())
        verdict = self._verdict(best)
        write_json(
            self.work.chunk(chunk.id),
            {
                "fingerprint": print_,
                "take": best["take"],
                "seconds": best["seconds"],
                "pause": chunk.pause_after,
                "block": chunk.block,
                "text": chunk.text,
                "words": best["words"],
                "match": verdict.match,
                "heard": verdict.heard,
                "review": [] if verdict.accepted else verdict.reasons(),
                "unsure": verdict.unsure,
                "takes": len(takes),
            },
        )

    def assemble(self, section: dict, chunks: list[Chunk], prints: dict[str, str]) -> None:
        number = section["section"]
        self.report({"type": "assembling", "section": number})
        results = [self.work.finished(c.id, prints[c.id]) for c in chunks]
        wav = self.work.section(number, ".wav")
        starts = join(
            [Piece(self.work.take_wav(c.id, prints[c.id], r["take"]), r["pause"]) for c, r in zip(chunks, results)],
            wav,
        )
        words, review = [], []
        for chunk, result, start in zip(chunks, results, starts):
            for i, (s, e, t0, t1, conf) in enumerate(result["words"]):
                words.append([chunk.block, s, e, round((start + t0) * 1000), round((start + t1) * 1000)])
            if result["review"]:
                review.append({
                    "chunk": chunk.id, "block": chunk.block, "start": chunk.start, "end": chunk.end,
                    "at": round(start * 1000), "reasons": result["review"],
                    "unsure": [result["words"][i][:2] for i in result["unsure"]],
                    "heard": result["heard"],
                })
        encode_m4a(wav, self.work.section(number, ".m4a"))
        duration = sf.info(wav).duration
        write_json(
            self.work.section(number, ".words.json"),
            {"version": 1, "section": number, "duration": round(duration, 3), "words": words, "review": review},
        )
        self.report({"type": "section", "section": number, "seconds": round(duration, 1), "review": len(review)})

    # -- progress ---------------------------------------------------------------

    def _progress(self, section: int, done: int, total: int, done_chars: int, total_chars: int, state: str) -> None:
        elapsed = time.monotonic() - self.started
        speed = self.generated_chars / elapsed if elapsed > 0 and self.generated_chars else None
        event = {
            "type": "progress",
            "state": state,
            "section": section,
            "chunksDone": done,
            "chunksTotal": total,
            "fraction": round(done_chars / total_chars, 4) if total_chars else 1,
            "audioSeconds": round(self.generated_seconds, 1),
            "elapsedSeconds": round(elapsed, 1),
            # Seconds of work per second of audio made: under 1 is faster than listening.
            "realTimeFactor": round(elapsed / self.generated_seconds, 2) if self.generated_seconds else None,
            "etaSeconds": round((total_chars - done_chars) / speed) if speed else None,
        }
        write_json(self.work.progress, event)
        self.report(event)
