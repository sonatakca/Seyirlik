import unittest

import numpy as np

from seyirlik_narrator.align import (
    FRAME_SECONDS,
    forced_align,
    time_words,
    word_confidence,
    word_tokens,
)
from seyirlik_narrator.text import words_in

VOCAB = {"<pad>": 0, "|": 1, "a": 2, "b": 3, "e": 4, "l": 5, "i": 6, "r": 7}


def emissions(frames: list[str], sure: float = 0.9) -> np.ndarray:
    """Log-probabilities where each frame strongly prefers one symbol ("-" is blank)."""
    probs = np.full((len(frames), len(VOCAB)), (1 - sure) / (len(VOCAB) - 1))
    for t, symbol in enumerate(frames):
        probs[t, 0 if symbol == "-" else VOCAB[symbol]] = sure
    return np.log(probs)


class ForcedAlignTest(unittest.TestCase):
    def test_follows_the_frames_through_repeated_characters(self):
        # "al" then "ele": the repeated e needs no blank in between to be read twice? It does: CTC
        # collapses repeats, so the path must pass a blank between the two e's.
        frames = list("--aa-ll|-ee-l-ee--")
        tokens = [VOCAB[c] for c in "al|ele"]
        path = forced_align(emissions(frames), tokens)
        token_frames = [int(np.flatnonzero(path == i)[0]) for i in range(len(tokens))]
        self.assertEqual(token_frames, [2, 5, 7, 9, 12, 14])

    def test_aligns_a_sentence_longer_than_an_int8_can_count(self):
        text = "ab" * 100
        frames = [c for pair in zip(text, "-" * len(text)) for c in pair]
        path = forced_align(emissions(frames), [VOCAB[c] for c in text])
        self.assertEqual(int(path[-2]), len(text) - 1)

    def test_refuses_more_characters_than_frames(self):
        with self.assertRaises(ValueError):
            forced_align(emissions(list("ab")), [VOCAB["a"], VOCAB["b"], VOCAB["a"]])


class WordConfidenceTest(unittest.TestCase):
    def test_forgives_one_lost_letter_but_not_a_garbled_word(self):
        # Measured on real takes: "ile" run into the word before, "Tiedemann", and "Sarhoşluğum" garbled.
        self.assertGreaterEqual(word_confidence([0.005, 0.998, 0.999]), 0.5)
        self.assertGreaterEqual(word_confidence([0.001, 0.002, 0.004, 0.9, 0.95, 0.99, 0.99, 0.99, 0.99]), 0.5)
        garbled = [0.001, 0.001, 0.002, 0.004, 0.01, 0.05, 0.8, 0.9, 0.95, 0.99, 0.99]
        self.assertLess(word_confidence(garbled), 0.5)


class TimeWordsTest(unittest.TestCase):
    def test_times_words_and_marks_a_missing_one_unsure(self):
        words = words_in("bir el bal")
        # "bir" and "bal" are clearly there; "el" is not: the frames between hold only silence.
        frames = list("-bbiirr--|--------|-bbaall--")
        timed = time_words(emissions(frames), words, VOCAB, VOCAB["|"])

        self.assertEqual([(w.start, w.end) for w in timed], [(0, 3), (4, 6), (7, 10)])
        self.assertAlmostEqual(timed[0].t0, 1 * FRAME_SECONDS)
        self.assertAlmostEqual(timed[0].t1, 7 * FRAME_SECONDS)
        self.assertGreater(timed[0].confidence, 0.8)
        self.assertGreater(timed[2].confidence, 0.8)
        self.assertLess(timed[1].confidence, 0.2)

    def test_spells_out_numbers_for_the_model(self):
        vocab = {**VOCAB, **{c: i + 10 for i, c in enumerate("onyimzdüçtk")}}
        tokens, spans = word_tokens(words_in("20 el"), vocab, vocab["|"])
        self.assertEqual(spans, [(0, 5), (6, 8)])  # "yirmi", then "el"


if __name__ == "__main__":
    unittest.main()
