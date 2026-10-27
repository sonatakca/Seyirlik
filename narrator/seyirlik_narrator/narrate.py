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

from .align import TimedWord, time_words
from .assemble import Piece, encode_m4a, join
from .models import HIGGS, Listener, Speaker
from .text import Chunk, chunk_section, spoken_chunk_words, tts_text
from .verify import Verdict, end_lift, judge, tone
from .work import WorkDir, read_json, write_json

ENGINE = "seyirlik-narrator/1"
MAX_TAKES = 3
BATCH = 4
# What a finished chunk was judged by: 1 the words, 2 also the tone. A chunk
# judged by fewer is judged again from its takes the next time its section is
# read, and read again only if none of them passes.
CHECKS = 2

Report = Callable[[dict], None]
Models = Callable[[], tuple[Speaker, Listener]]


def fingerprint(chunk: Chunk, voice: dict, pronunciations: dict[str, str] | None = None, round_: int = 0) -> str:
    key = {"engine": ENGINE, "model": HIGGS, "voice": voice, "text": tts_text(chunk.text, pronunciations)}
    # A chunk read again (asked for, or its takes failed a check added since)
    # is a new reading: the takes before it are not among its tries.
    if round_:
        key["round"] = round_
    return hashlib.sha256(json.dumps(key, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24]


def signature(chunks: list[Chunk], results: list[dict]) -> str:
    """Names the takes a section's recording is made of: another take anywhere is another recording."""
    parts = [[c.id, r["fingerprint"], r["take"]] for c, r in zip(chunks, results)]
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:24]


class Narration:
    """Reads a script's sections. The speech models are loaded only once a chunk
    has to be read: a section with nothing new to read is only checked."""

    def __init__(
        self,
        script: dict,
        work: WorkDir,
        voice: dict,
        models: Models,
        report: Report,
        pronunciations: dict[str, str] | None = None,
        retakes: dict[str, int] | None = None,
    ):
        self.script = script
        self.work = work
        self.voice = voice
        self.models = models
        self.report = report
        self.pronunciations = pronunciations or {}
        # How many times a person asked for each chunk to be read again.
        self.retakes = retakes or {}
        self.started = time.monotonic()
        self.generated_seconds = 0.0  # audio made by this run, for its speed
        self.generated_chars = 0

    @property
    def _rounds_file(self) -> Path:
        return self.work.root / "rounds.json"

    def _print(self, chunk: Chunk, rounds: dict[str, int]) -> str:
        return fingerprint(chunk, self.voice, self.pronunciations, self.retakes.get(chunk.id, 0) + rounds.get(chunk.id, 0))

    # -- one take -------------------------------------------------------------

    def _analyse(self, chunk: Chunk, print_: str, take: int, audio: np.ndarray) -> dict:
        speaker, listener = self.models()
        rate = speaker.sample_rate
        wav = self.work.take_wav(chunk.id, print_, take)
        sf.write(wav, audio, rate, subtype="PCM_16")
        seconds = len(audio) / rate
        timed = []
        if seconds > 0.2:
            try:
                # Timed by the words as the voice was given them, at the book's offsets.
                words = spoken_chunk_words(chunk, self.pronunciations)
                timed = time_words(listener.log_probs(audio, rate), words, listener.vocab, listener.separator, listener.blank)
            except ValueError:  # far too short for its words: the verdict says so below
                timed = []
        heard = listener.hear(audio, rate) if seconds > 0.2 else ""
        verdict = judge(tts_text(chunk.text, self.pronunciations), heard, timed, seconds, end_lift(audio, rate, timed))
        if not timed:
            verdict.rate_ok = False
        result = {
            "take": take,
            "seconds": round(seconds, 3),
            "checks": CHECKS,
            "verdict": asdict(verdict),
            "words": [[w.start, w.end, w.t0, w.t1, w.confidence] for w in timed],
        }
        write_json(wav.with_suffix(".json"), result)
        return result

    @staticmethod
    def _verdict(result: dict) -> Verdict:
        return Verdict(**result["verdict"])

    def _rejudge(self, chunk: Chunk, print_: str) -> bool:
        """Judges a finished chunk's takes by the checks added since; False if it must be read again."""
        results = []
        for n in range(1, self.work.takes(chunk.id, print_) + 1):
            wav = self.work.take_wav(chunk.id, print_, n)
            result = read_json(wav.with_suffix(".json"))
            if result is None:
                continue
            if result.get("checks", 1) < CHECKS:
                audio, rate = sf.read(wav, dtype="float32")
                timed = [TimedWord(s, e, t0, t1, c) for s, e, t0, t1, c in result["words"]]
                verdict = result["verdict"]
                verdict.update(tone(tts_text(chunk.text, self.pronunciations), verdict.get("heard", ""), end_lift(audio, rate, timed)))
                result["checks"] = CHECKS
                write_json(wav.with_suffix(".json"), result)
            results.append(result)
        if not results:
            return False
        best = self._verdict(max(results, key=lambda r: self._verdict(r).rank()))
        if not best.accepted and best.toned:
            return False
        self._finish(chunk, print_, results)
        return True

    # -- a section ------------------------------------------------------------

    def run_section(self, section: dict, only_blocks: set[int] | None = None) -> bool:
        """Reads what the section still needs and makes its recording; True if the recording was made anew."""
        chunks = [c for c in chunk_section(section) if only_blocks is None or c.block in only_blocks]
        rounds: dict[str, int] = read_json(self._rounds_file) or {}
        prints = {c.id: self._print(c, rounds) for c in chunks}

        # A chunk finished before a check was added is judged by it now, from its takes.
        reopened = []
        for c in chunks:
            result = self.work.finished(c.id, prints[c.id])
            if result and result.get("checks", 1) < CHECKS and not self._rejudge(c, prints[c.id]):
                reopened.append(c.id)
        if reopened:
            for chunk_id in reopened:
                rounds[chunk_id] = rounds.get(chunk_id, 0) + 1
            write_json(self._rounds_file, rounds)
            prints = {c.id: self._print(c, rounds) for c in chunks}
            self.report({"type": "reopened", "section": section["section"], "chunks": reopened})

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
            # Which lines the voice reads now, so a person waiting for one can follow it.
            self.report({
                "type": "speaking", "section": section["section"],
                "chunks": [{"chunk": c.id, "take": len(tries[c.id]) + 1} for c in batch],
            })
            speaker, _ = self.models()
            audios = speaker.say([tts_text(c.text, self.pronunciations) for c in batch])
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
        if only_blocks is None and self._current(section["section"], chunks, prints):
            return False
        self.assemble(section, chunks, prints)
        return True

    def _current(self, number: int, chunks: list[Chunk], prints: dict[str, str]) -> bool:
        """Whether the section's recording is already made of exactly these takes."""
        check = read_json(self.work.section(number, ".check.json"))
        if not check or not self.work.section(number, ".m4a").exists() or not self.work.section(number, ".words.json").exists():
            return False
        results = [self.work.finished(c.id, prints[c.id]) for c in chunks]
        return check.get("signature") == signature(chunks, results)

    def _finish(self, chunk: Chunk, print_: str, takes: list[dict]) -> None:
        best = max(takes, key=lambda r: self._verdict(r).rank())
        verdict = self._verdict(best)
        spoken = tts_text(chunk.text, self.pronunciations)
        write_json(
            self.work.chunk(chunk.id),
            {
                "fingerprint": print_,
                "take": best["take"],
                "seconds": best["seconds"],
                "pause": chunk.pause_after,
                "block": chunk.block,
                "text": chunk.text,
                # What the voice was given, where a pronunciation changed it.
                "spoken": spoken if spoken != tts_text(chunk.text) else None,
                "words": best["words"],
                "match": verdict.match,
                "heard": verdict.heard,
                "lift": verdict.lift,
                "review": [] if verdict.accepted else verdict.reasons(),
                "unsure": verdict.unsure,
                "takes": len(takes),
                "checks": CHECKS,
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
        words, review, lines = [], [], []
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
            # Every line, for the review page: what the book says beside what was heard.
            lines.append({
                "chunk": chunk.id, "block": chunk.block, "start": chunk.start, "end": chunk.end,
                "at": round(start * 1000), "duration": round(result["seconds"] * 1000),
                "heard": result["heard"], "spoken": result.get("spoken"),
                "match": result["match"], "lift": result.get("lift"),
                "reasons": result["review"],
                "unsure": [result["words"][i][:2] for i in result["unsure"]],
                "takes": result["takes"], "retakes": self.retakes.get(chunk.id, 0),
            })
        encode_m4a(wav, self.work.section(number, ".m4a"))
        duration = sf.info(wav).duration
        write_json(
            self.work.section(number, ".words.json"),
            {"version": 1, "section": number, "duration": round(duration, 3), "words": words, "review": review},
        )
        write_json(
            self.work.section(number, ".check.json"),
            {"version": 1, "section": number, "signature": signature(chunks, results), "lines": lines},
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
