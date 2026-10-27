import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from seyirlik_narrator import narrate as narrate_module
from seyirlik_narrator.align import TimedWord
from seyirlik_narrator.narrate import Narration
from seyirlik_narrator.text import words_in
from seyirlik_narrator.work import WorkDir, read_json, write_json

RATE = 1000
SECTION = {
    "section": 1,
    "blocks": [
        {"block": 0, "text": "Benim gibi yavaş bir adam."},
        {"block": 1, "text": "Mıhlanıp kaldı: Maria Puder..."},
        {"block": 2, "text": "Sergievi kapalıydı o gün."},
    ],
}


class FakeSpeaker:
    sample_rate = RATE

    def __init__(self):
        self.said: list[str] = []
        self.text_of: dict[int, str] = {}

    def say(self, texts):
        self.said += texts
        # A plausible length: 80 ms a character, and the edges' silence.
        takes = [np.full(int((0.08 * len(t) + 0.6) * RATE), 0.1, dtype=np.float32) for t in texts]
        self.text_of.update({id(take): text for take, text in zip(takes, texts)})
        return takes


class FakeListener:
    vocab: dict = {}
    separator = blank = 0

    def __init__(self, hear):
        self._hear = hear

    def log_probs(self, audio, rate):
        return np.zeros((1, 1))

    def hear(self, audio, rate):
        return self._hear(audio)


def even_timing(log_probs, words, *args):
    """Every word an equal share of the take, all of them sure."""
    return [TimedWord(w.start, w.end, 0.3 + i * 0.2, 0.3 + i * 0.2 + 0.15, 0.99) for i, w in enumerate(words)]


class NarrationTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.work = WorkDir(self.root)
        self.speaker = FakeSpeaker()
        self.heard = None  # what Whisper hears: the text it was given, unless a test says otherwise
        self.loads = 0
        for patch in (
            mock.patch.object(narrate_module, "time_words", even_timing),
            mock.patch.object(narrate_module, "encode_m4a", lambda wav, out: shutil.copy(wav, out)),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def models(self):
        self.loads += 1
        def hear(audio):
            text = self.speaker.text_of[id(audio)]
            return self.heard(text) if self.heard else text

        return self.speaker, FakeListener(hear)

    def narration(self, **options):
        return Narration({"sections": [SECTION]}, self.work, {"name": "mk"}, self.models, lambda event: None, **options)

    def test_reads_a_section_and_writes_every_line_for_review(self):
        self.assertTrue(self.narration().run_section(SECTION))
        check = read_json(self.work.section(1, ".check.json"))
        self.assertEqual([line["chunk"] for line in check["lines"]], ["1-0-0", "1-1-0", "1-2-0"])
        line = check["lines"][1]
        self.assertEqual((line["block"], line["start"], line["end"]), (1, 0, 30))
        self.assertEqual(line["heard"], "Mıhlanıp kaldı: Maria Puder...")
        self.assertEqual(line["reasons"], [])
        self.assertGreater(line["duration"], 0)

    def test_a_section_with_nothing_new_is_only_checked(self):
        self.narration().run_section(SECTION)
        loads, said = self.loads, len(self.speaker.said)
        self.assertFalse(self.narration().run_section(SECTION))
        self.assertEqual((self.loads, len(self.speaker.said)), (loads, said))

    def test_a_line_asked_for_again_is_read_again_alone(self):
        self.narration().run_section(SECTION)
        self.speaker.said.clear()
        events = []
        narration = self.narration(retakes={"1-1-0": 1})
        narration.report = events.append
        self.assertTrue(narration.run_section(SECTION))
        # Said before the voice reads it, so the page waiting for it can say so.
        self.assertIn({"type": "speaking", "section": 1, "chunks": [{"chunk": "1-1-0", "take": 1}]}, events)
        self.assertEqual(self.speaker.said, ["Mıhlanıp kaldı: Maria Puder..."])
        self.assertEqual(read_json(self.work.section(1, ".check.json"))["lines"][1]["retakes"], 1)

    def test_a_pronunciation_rereads_only_the_lines_with_that_word(self):
        self.narration().run_section(SECTION)
        self.speaker.said.clear()
        self.narration(pronunciations={"sergievi": "sergi evi"}).run_section(SECTION)
        self.assertEqual(self.speaker.said, ["Sergi evi kapalıydı o gün."])
        line = read_json(self.work.section(1, ".check.json"))["lines"][2]
        self.assertEqual(line["spoken"], "Sergi evi kapalıydı o gün.")
        # The words are still the book's, where the reader finds them.
        words = read_json(self.work.section(1, ".words.json"))["words"]
        self.assertEqual([w[:3] for w in words if w[0] == 2][0], [2, 0, 8])

    def test_a_cried_out_line_is_read_again_and_the_calmer_take_kept(self):
        cries = iter([True, True, False])
        self.heard = lambda text: text.replace("Puder...", "Puder!") if "Puder" in text and next(cries) else text
        self.narration().run_section(SECTION)
        chunk = read_json(self.work.chunk("1-1-0"))
        self.assertEqual((chunk["take"], chunk["takes"], chunk["review"]), (3, 3, []))

    def test_lines_finished_before_the_tone_check_are_judged_by_it_from_their_takes(self):
        self.narration().run_section(SECTION)
        # As every line of the first book was: judged by the words alone, with
        # Maria Puder heard as a cry and taken anyway.
        for chunk_id in ("1-0-0", "1-1-0", "1-2-0"):
            chunk = read_json(self.work.chunk(chunk_id))
            take = self.work.take_wav(chunk_id, chunk["fingerprint"], 1).with_suffix(".json")
            result = read_json(take)
            for key in ("exclaimed", "loud_end", "lift"):
                result["verdict"].pop(key)
            result.pop("checks")
            if chunk_id == "1-1-0":
                result["verdict"]["heard"] = "Mıhlanıp kaldı. Maria Puder!"
            write_json(take, result)
            for key in ("checks", "lift", "spoken"):
                chunk.pop(key)
            write_json(self.work.chunk(chunk_id), chunk)
        self.speaker.said.clear()
        loads = self.loads

        self.assertTrue(self.narration().run_section(SECTION))
        # Only the cried line is read again, in a round of its own.
        self.assertEqual(self.speaker.said, ["Mıhlanıp kaldı: Maria Puder..."])
        self.assertEqual(read_json(self.work.root / "rounds.json"), {"1-1-0": 1})
        self.assertEqual(read_json(self.work.chunk("1-1-0"))["review"], [])
        self.assertEqual(read_json(self.work.chunk("1-0-0"))["checks"], 2)
        self.assertGreater(self.loads, loads)


if __name__ == "__main__":
    unittest.main()
