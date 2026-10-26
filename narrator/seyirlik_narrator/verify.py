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
from dataclasses import dataclass, field

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


@dataclass
class Verdict:
    match: float
    missed_run: int
    unsure: list[int] = field(default_factory=list)  # indexes into the chunk's words
    rate_ok: bool = True
    heard: str = ""

    @property
    def accepted(self) -> bool:
        return (
            self.rate_ok
            and self.match >= GOOD_MATCH
            and self.missed_run <= MAX_MISSED_RUN
            and len(self.unsure) <= MAX_UNSURE
        )

    def rank(self) -> tuple:
        """Larger is better: a sane length first, then fewest skipped and unsure words."""
        return (self.rate_ok, -self.missed_run, -len(self.unsure), self.match)

    def reasons(self) -> list[str]:
        out = []
        if not self.rate_ok:
            out.append("length")
        if self.missed_run > MAX_MISSED_RUN or self.match < GOOD_MATCH:
            out.append("skipped-words")
        if self.unsure:
            out.append("pronunciation")
        return out


def comparable(text: str) -> str:
    """The letters both sides can be compared by: lower-cased, numbers spelled out, and no
    spaces, since Whisper writes "akşam üzeri" and "gülümsemeyle" where the book has
    "akşamüzeri" and "gülümseme ile"."""
    return "".join(s for w in words_in(text) for s in spoken_words(w.text))


def judge(expected: str, heard: str, timed: list[TimedWord], seconds: float) -> Verdict:
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
    )
