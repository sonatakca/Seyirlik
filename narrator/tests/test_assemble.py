import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from seyirlik_narrator.assemble import Piece, edge_silence, join

RATE = 24_000


def tone(seconds: float, lead: float = 0.0, tail: float = 0.0) -> np.ndarray:
    t = np.arange(int(seconds * RATE)) / RATE
    voice = 0.3 * np.sin(2 * np.pi * 220 * t).astype(np.float32)
    return np.concatenate([np.zeros(int(lead * RATE), np.float32), voice, np.zeros(int(tail * RATE), np.float32)])


class JoinTest(unittest.TestCase):
    def test_measures_the_quiet_at_each_edge(self):
        audio = tone(1.0, lead=0.2, tail=0.3)
        self.assertAlmostEqual(edge_silence(audio, RATE, trailing=False), 0.2, delta=0.02)
        self.assertAlmostEqual(edge_silence(audio, RATE, trailing=True), 0.3, delta=0.02)

    def test_adds_only_the_silence_that_is_missing_and_reports_where_each_take_starts(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            a, b, c = folder / "a.wav", folder / "b.wav", folder / "c.wav"
            sf.write(a, tone(1.0, tail=0.2), RATE)
            sf.write(b, tone(1.0, lead=0.1), RATE)
            sf.write(c, tone(0.5), RATE)
            out = folder / "out.wav"

            # a→b wants 1.0 s and already has 0.3; b→c wants 0.55 and has none.
            starts = join([Piece(a, 1.0), Piece(b, 0.55), Piece(c, 1.0)], out)

            self.assertAlmostEqual(starts[1], 1.2 + 0.7, delta=0.03)
            self.assertAlmostEqual(starts[2], starts[1] + 1.1 + 0.55, delta=0.03)
            self.assertAlmostEqual(sf.info(out).duration, starts[2] + 0.5, delta=0.01)
            # The speech itself is untouched.
            joined, _ = sf.read(out, dtype="float32")
            original, _ = sf.read(b, dtype="float32")
            first = round(starts[1] * RATE)
            np.testing.assert_allclose(joined[first : first + len(original)], original, atol=1e-4)


if __name__ == "__main__":
    unittest.main()
