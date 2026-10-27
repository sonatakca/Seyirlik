"""Whether a take says what the book says, and which words to look at again.

Two independent signals. Whisper hears the take with no knowledge of the text,
so a word Higgs skipped is missing from what it heard. The aligner knows the
text and scores each word where it was said, so a word that is there but
mispronounced scores low even when Whisper guesses it right. Neither is proof;
together they decide which takes to try again and which words a person
should listen to.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

import numpy as np

from .align import TimedWord
from .text import spoken_words, words_in

# Below this, the aligner was unsure the word was said as written (see word_confidence).
UNSURE_WORD = 0.5
# A take is accepted when what Whisper heard matches this well, letter for letter...
GOOD_MATCH = 0.9
# ...no more letters than this were missed in a row (about two short words)...
MAX_MISSED_RUN = 10
# ...and no more than this many words were unsure.
MAX_UNSURE = 1
# Speech rate sanity: seconds per spoken character, from the first samples.
SLOWEST, FASTEST = 0.16, 0.03
EDGE_ALLOWANCE = 0.6
# A take whose last words are this much louder (dB) than its middle word was
# cried out. Measured on Kürk Mantolu Madonna: a line's last words sit about
# 2 dB under its median, and "...mıhlanıp kaldı: Maria Puder..." said as
# "Maria Puder!" sat 9.4 dB over it.
LOUD_END = 8.0


@dataclass
class Verdict:
    match: float
    missed_run: int
    unsure: list[int] = field(default_factory=list)  # indexes into the chunk's words
    rate_ok: bool = True
    heard: str = ""
    # The tone: Whisper heard an exclamation the book does not have, or the
    # line ends loud where its text gives no reason to. Takes judged before
    # these were measured have neither.
    exclaimed: bool = False
    loud_end: bool = False
    lift: float | None = None

    @property
    def toned(self) -> bool:
        return self.exclaimed or self.loud_end

    @property
    def accepted(self) -> bool:
        return (
            self.rate_ok
            and self.match >= GOOD_MATCH
            and self.missed_run <= MAX_MISSED_RUN
            and len(self.unsure) <= MAX_UNSURE
            and not self.toned
        )

    def rank(self) -> tuple:
        """Larger is better: a sane length first, then fewest skipped and unsure words, then the calmer."""
        return (self.rate_ok, -self.missed_run, -len(self.unsure), not self.toned, self.match, -(self.lift or 0.0))

    def reasons(self) -> list[str]:
        out = []
        if not self.rate_ok:
            out.append("length")
        if self.missed_run > MAX_MISSED_RUN or self.match < GOOD_MATCH:
            out.append("skipped-words")
        if self.unsure:
            out.append("pronunciation")
        if self.toned:
            out.append("tone")
        return out


def comparable(text: str) -> str:
    """The letters both sides can be compared by: lower-cased, numbers spelled out, and no
    spaces, since Whisper writes "akşam üzeri" and "gülümsemeyle" where the book has
    "akşamüzeri" and "gülümseme ile"."""
    return "".join(s for w in words_in(text) for s in spoken_words(w.text))


def end_lift(audio: np.ndarray, rate: int, timed: list[TimedWord]) -> float | None:
    """How much louder, in dB, the loudest of the last two words is than the take's median word."""
    if len(timed) < 3:
        return None
    levels = []
    for word in timed:
        x = audio[int(word.t0 * rate):int(word.t1 * rate)]
        levels.append(20 * float(np.log10(np.sqrt(np.mean(np.square(x, dtype=np.float64))) + 1e-9)) if len(x) else -180.0)
    return round(max(levels[-2:]) - float(np.median(levels)), 1)


def last_sentence(text: str) -> str:
    return re.split(r"(?<=[.?…])\s+", text.strip())[-1]


def tone(expected: str, heard: str, lift: float | None) -> dict:
    """The tone fields of a verdict: what was cried out that the book says quietly."""
    return {
        "exclaimed": heard.count("!") > expected.count("!"),
        "loud_end": lift is not None and lift >= LOUD_END and "!" not in last_sentence(expected),
        "lift": lift,
    }


def judge(expected: str, heard: str, timed: list[TimedWord], seconds: float, lift: float | None = None) -> Verdict:
    a, b = comparable(expected), comparable(heard)
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    missed = max(
        (a1 - a0 for op, a0, a1, _, _ in matcher.get_opcodes() if op in ("delete", "replace")),
        default=0,
    )
    characters = len(a) or 1
    return Verdict(
        match=round(matcher.ratio(), 3) if a or b else 0.0,
        missed_run=missed,
        unsure=[i for i, w in enumerate(timed) if w.confidence < UNSURE_WORD],
        # A take carries some silence at its edges, which a one-word take would otherwise be judged by.
        rate_ok=FASTEST <= max(0.0, seconds - EDGE_ALLOWANCE) / characters <= SLOWEST,
        heard=heard,
        **tone(expected, heard, lift),
    )
