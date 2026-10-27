"""When each written word is spoken in a take, by CTC forced alignment.

The text is known, so nothing is recognised: a CTC acoustic model (MMS with
its Turkish adapter) scores every character at every 20 ms frame, and the
single best path through the expected characters gives each word a start, an
end and a confidence. A word the model said wrongly, or not at all, still gets
a place on that path, but a poor score: that is what flags it for review.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .text import Word, spoken_words

FRAME_SECONDS = 0.02  # wav2vec2: 320 samples at 16 kHz
MMS_SAMPLE_RATE = 16_000


@dataclass(frozen=True)
class TimedWord:
    start: int
    end: int
    t0: float
    t1: float
    confidence: float


def word_tokens(words: list[Word], vocab: dict[str, int], separator: int) -> tuple[list[int], list[tuple[int, int]]]:
    """The character tokens of the words as spoken, and each word's [first, last) token range.

    Words are joined by the separator token. A character the model has no
    token for (rare punctuation inside a word) is left out; a word left with
    no characters at all takes the separator, so it still gets a place.
    """
    tokens: list[int] = []
    spans: list[tuple[int, int]] = []
    for i, word in enumerate(words):
        if i:
            tokens.append(separator)
        first = len(tokens)
        for j, spoken in enumerate(spoken_words(word.text)):
            if j:
                tokens.append(separator)
            tokens += [vocab[c] for c in spoken if c in vocab]
        if len(tokens) == first:
            tokens.append(separator)
        spans.append((first, len(tokens)))
    return tokens, spans


def forced_align(log_probs: np.ndarray, tokens: list[int], blank: int = 0) -> np.ndarray:
    """The best CTC path: for each frame, the index of the token it belongs to, or -1 for blank.

    `log_probs` is (frames, vocabulary). Classic Viterbi over the sequence
    blank, t0, blank, t1, ..., blank, where a step may stay, move on by one,
    or skip a blank between two different tokens.
    """
    frames = log_probs.shape[0]
    states = 2 * len(tokens) + 1
    labels = np.full(states, blank, dtype=np.int64)
    labels[1::2] = tokens
    if frames < len(tokens):
        raise ValueError(f"{frames} frames cannot hold {len(tokens)} characters")

    can_skip = np.zeros(states, dtype=bool)
    can_skip[3::2] = labels[3::2] != labels[1:-2:2]

    score = np.full(states, -np.inf)
    score[0] = log_probs[0, blank]
    score[1] = log_probs[0, labels[1]]
    back = np.zeros((frames, states), dtype=np.int8)  # 0 stay, 1 from previous, 2 skip
    for t in range(1, frames):
        stay = score
        prev = np.concatenate(([-np.inf], score[:-1]))
        skip = np.where(can_skip, np.concatenate(([-np.inf, -np.inf], score[:-2])), -np.inf)
        best = np.stack([stay, prev, skip])
        choice = best.argmax(axis=0)
        score = best[choice, np.arange(states)] + log_probs[t, labels]
        back[t] = choice

    # The path ends on the last token or the blank after it.
    state = states - 1 if score[-1] >= score[-2] else states - 2
    path = np.empty(frames, dtype=np.int64)
    for t in range(frames - 1, -1, -1):
        path[t] = state
        state -= int(back[t, state])  # a bare int8 would make `state` an int8 too
    return np.where(path % 2 == 1, path // 2, -1)


def word_confidence(characters: list[float]) -> float:
    """How surely a word was said as written, from how sure the model was of each character.

    Natural speech loses single letters all the time — "ile" run into the word
    before it, a soft "h", a doubled consonant said once, a foreign name — so one
    near-silent character means nothing. A garbled word loses several: in the
    take that said "Sarhoşluğum" as "rolaşlık", six of its eleven characters were
    near zero and their mean was 0.38, while no clearly spoken word in the trial
    passage fell below a mean of 0.62 or lost more than a third of its letters.
    """
    lost = sum(p < 0.1 for p in characters) / len(characters)
    return min(float(np.mean(characters)), 1.0 - lost)


def time_words(log_probs: np.ndarray, words: list[Word], vocab: dict[str, int], separator: int, blank: int = 0) -> list[TimedWord]:
    """Each word's spoken span, in seconds from the start of the take."""
    tokens, spans = word_tokens(words, vocab, separator)
    path = forced_align(log_probs, tokens, blank)
    probs = np.exp(log_probs)

    timed = []
    for word, (first, last) in zip(words, spans):
        frames = np.flatnonzero((path >= first) & (path < last))
        if len(frames) == 0:  # cannot happen on a valid path; keep the word anyway
            timed.append(TimedWord(word.start, word.end, 0.0, 0.0, 0.0))
            continue
        by_token: dict[int, list[float]] = {}
        for f in frames:
            by_token.setdefault(int(path[f]), []).append(float(probs[f, tokens[path[f]]]))
        timed.append(
            TimedWord(
                word.start,
                word.end,
                round(frames[0] * FRAME_SECONDS, 3),
                round((frames[-1] + 1) * FRAME_SECONDS, 3),
                round(word_confidence([float(np.mean(p)) for p in by_token.values()]), 3),
            )
        )
    return timed
