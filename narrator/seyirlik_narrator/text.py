"""Words, spoken forms and chunks of a narration script's text.

A block's text is the reader's own (`epubBlockText`), so every offset here is
a character index into that string: the reader finds a word on the page by
its block and these offsets. Nothing in this module may change the text it is
given; it only cuts it and describes how its words sound.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

# A word is letters and digits, with the joins Turkish writes inside one:
# "Tiedemann’ın", "1933'te", "otuz-beş".
WORD = re.compile(r"[^\W_]+(?:['’\-][^\W_]+)*")
DIGITS = re.compile(r"\d+")

# Where a chunk may end, best first.
SENTENCE_END = re.compile(r"(?:\.\.\.|[.!?…])[\"'”’»)]*(?=\s)")
CLAUSE_END = re.compile(r"[;:—–](?=\s)|(?<=\s)[—–](?=\s)")
COMMA = re.compile(r",(?=\s)")

# A chunk is about two sentences: Higgs skips words in longer ones. A block
# that fits under the maximum is one chunk, so its intonation is one take's.
CHUNK_TARGET = 280
CHUNK_MAX = 360

OPEN_QUOTES = "“«"
CLOSE_QUOTES = "”»"


@dataclass(frozen=True)
class Word:
    start: int
    end: int
    text: str


@dataclass
class Chunk:
    """A piece of one block, generated as one take."""

    section: int
    block: int
    index: int
    start: int
    end: int
    text: str
    heading: bool
    block_end: bool
    words: list[Word] = field(default_factory=list)

    @property
    def id(self) -> str:
        return f"{self.section}-{self.block}-{self.index}"

    @property
    def pause_after(self) -> float:
        """The silence the listener should hear after this chunk, in seconds."""
        if self.block_end:
            return 1.6 if self.heading else 1.0
        tail = self.text.rstrip("\"'”’») ")
        if tail.endswith(("...", "…")):
            return 0.95
        if tail.endswith(("?", "!")):
            return 0.75
        if tail.endswith((",", ";", ":")):
            return 0.35
        return 0.55


def turkish_lower(text: str) -> str:
    return text.replace("I", "ı").replace("İ", "i").lower()


def tts_text(text: str) -> str:
    """What the model is asked to say: the same words, without invisible format characters."""
    text = unicodedata.normalize("NFC", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Cf")
    return " ".join(text.split())


_ONES = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"]
_TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"]
_SCALES = [(10**9, "milyar"), (10**6, "milyon"), (1000, "bin")]


def _below_thousand(n: int) -> list[str]:
    hundreds, rest = divmod(n, 100)
    words = []
    if hundreds:
        words += (["yüz"] if hundreds == 1 else [_ONES[hundreds], "yüz"])
    tens, ones = divmod(rest, 10)
    words += [w for w in (_TENS[tens], _ONES[ones]) if w]
    return words


def number_words(digits: str) -> list[str]:
    """A run of digits as Turkish says it: "1933" → bin dokuz yüz otuz üç."""
    n = int(digits)
    if n == 0 or len(digits) > 12:
        return [_ONES[int(d)] or "sıfır" for d in digits]
    words: list[str] = []
    for scale, name in _SCALES:
        count, n = divmod(n, scale)
        if count:
            # "bin", never "bir bin"; but "bir milyon".
            words += [name] if (count == 1 and scale == 1000) else _below_thousand(count) + [name]
    return words + _below_thousand(n)


def spoken_words(word: str) -> list[str]:
    """How a written word sounds, lower-cased and spelled out: "1933'te" → bin dokuz yüz otuz üçte."""
    parts: list[str] = []
    pending = ""
    for piece in re.split(r"(\d+)", turkish_lower(word)):
        if not piece:
            continue
        if piece.isdigit():
            spelled = number_words(piece)
            parts += ([pending] if pending else []) + spelled[:-1]
            pending = spelled[-1]
        else:
            pending += piece
    if pending:
        parts.append(pending)
    return [p.replace("'", "").replace("’", "").replace("-", "") for p in parts if p]


def words_in(text: str, offset: int = 0) -> list[Word]:
    return [Word(m.start() + offset, m.end() + offset, m.group()) for m in WORD.finditer(text)]


def _quote_depths(text: str) -> list[int]:
    depth, depths = 0, []
    for c in text:
        if c in OPEN_QUOTES:
            depth += 1
        elif c in CLOSE_QUOTES:
            depth = max(0, depth - 1)
        depths.append(depth)
    return depths


def _starts_sentence(text: str, at: int) -> bool:
    """Whether what follows `at` begins a sentence: "“Seni gidi çapkın seni!” manasına" goes on."""
    rest = text[at:].lstrip()
    return not rest or rest[0].isupper() or rest[0].isdigit() or rest[0] in "\"“«'‘(–—-"


def _cut_points(text: str) -> list[tuple[int, int]]:
    """Every place a chunk may end, as (end offset, rank): lower rank is a better place."""
    depths = _quote_depths(text)
    points = []
    for m in SENTENCE_END.finditer(text):
        if not _starts_sentence(text, m.end()):
            points.append((m.end(), 2))  # an exclamation inside the sentence: a clause, no more
            continue
        points.append((m.end(), 0 if depths[m.end() - 1] == 0 else 1))
    points += [(m.end(), 2) for m in CLAUSE_END.finditer(text)]
    points += [(m.end(), 3) for m in COMMA.finditer(text)]
    points += [(m.start(), 4) for m in re.finditer(r"\s", text)]
    return sorted(points)


def cut_block(text: str) -> list[tuple[int, int]]:
    """A block's text as (start, end) ranges near CHUNK_TARGET, never mid-word, covering every character."""
    ranges = []
    start = 0
    while len(text) - start > CHUNK_MAX:
        window = [(end, rank) for end, rank in _cut_points(text) if start < end <= start + CHUNK_MAX]
        if not window:
            end = start + CHUNK_MAX  # one word longer than a chunk: nothing to do but cut it
        else:
            best = min(rank for _, rank in window)
            # The best kind of cut, as close to the target as it comes.
            end = min((e for e, r in window if r == best), key=lambda e: abs(e - start - CHUNK_TARGET))
        ranges.append((start, end))
        start = end
    ranges.append((start, len(text)))
    return ranges


def chunk_section(section: dict) -> list[Chunk]:
    chunks: list[Chunk] = []
    for block in section["blocks"]:
        text = block["text"]
        ranges = cut_block(text)
        for index, (start, end) in enumerate(ranges):
            # Leading and trailing spaces stay out of the chunk but inside no other.
            while start < end and text[start].isspace():
                start += 1
            while end > start and text[end - 1].isspace():
                end -= 1
            chunks.append(
                Chunk(
                    section=section["section"],
                    block=block["block"],
                    index=index,
                    start=start,
                    end=end,
                    text=text[start:end],
                    heading=bool(block.get("heading")),
                    block_end=index == len(ranges) - 1,
                    words=words_in(text[start:end], start),
                )
            )
    return chunks
