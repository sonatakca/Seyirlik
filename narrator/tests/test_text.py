import unittest

from seyirlik_narrator.text import (
    CHUNK_MAX,
    Chunk,
    chunk_section,
    number_words,
    spoken_words,
    turkish_lower,
    words_in,
)


class NumbersTest(unittest.TestCase):
    def test_says_numbers_as_turkish_does(self):
        self.assertEqual(number_words("1933"), ["bin", "dokuz", "yüz", "otuz", "üç"])
        self.assertEqual(number_words("20"), ["yirmi"])
        self.assertEqual(number_words("100"), ["yüz"])
        self.assertEqual(number_words("2001"), ["iki", "bin", "bir"])
        self.assertEqual(number_words("1000000"), ["bir", "milyon"])
        self.assertEqual(number_words("0"), ["sıfır"])

    def test_joins_a_suffix_to_the_last_number_word(self):
        self.assertEqual(spoken_words("1933'te"), ["bin", "dokuz", "yüz", "otuz", "üçte"])
        self.assertEqual(spoken_words("Tiedemann’ın"), ["tiedemannın"])

    def test_lowers_the_dotted_and_dotless_i(self):
        self.assertEqual(turkish_lower("IŞIK İSTANBUL"), "ışık istanbul")


class WordsTest(unittest.TestCase):
    def test_keeps_apostrophe_suffixes_and_offsets(self):
        text = "Frau Tiedemann’ın ayağı, “Kürk Mantolu Madonna”ydı."
        words = words_in(text)
        self.assertEqual([w.text for w in words], ["Frau", "Tiedemann’ın", "ayağı", "Kürk", "Mantolu", "Madonna", "ydı"])
        for w in words:
            self.assertEqual(text[w.start : w.end], w.text)


def block(n, text, heading=False):
    return {"block": n, "heading": heading, "text": text}


class ChunkTest(unittest.TestCase):
    def test_a_short_block_is_one_chunk_with_a_paragraph_pause(self):
        [chunk] = chunk_section({"section": 1, "blocks": [block(4, "Sokuldum.")]})
        self.assertEqual((chunk.id, chunk.start, chunk.end, chunk.text), ("1-4-0", 0, 9, "Sokuldum."))
        self.assertEqual(chunk.pause_after, 1.0)

    def test_a_heading_gets_a_longer_pause(self):
        [chunk] = chunk_section({"section": 1, "blocks": [block(0, "20 Haziran 1933", heading=True)]})
        self.assertEqual(chunk.pause_after, 1.6)

    def test_a_long_block_is_cut_at_sentence_ends_and_covers_every_word(self):
        sentence = "Bu, kafamda bir şimşek gibi çakan ve hiç unutamadığım o gecenin hikâyesidir. "
        text = (sentence * 12).strip()
        chunks = chunk_section({"section": 1, "blocks": [block(7, text)]})

        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertLessEqual(len(chunk.text), CHUNK_MAX)
            self.assertTrue(chunk.text.endswith("."))
            self.assertEqual(text[chunk.start : chunk.end], chunk.text)
        self.assertEqual([c.block_end for c in chunks], [False] * (len(chunks) - 1) + [True])
        self.assertEqual(chunks[0].pause_after, 0.55)
        self.assertEqual(
            [w.text for c in chunks for w in c.words],
            [w.text for w in words_in(text)],
        )

    def test_prefers_a_sentence_end_outside_quotes(self):
        inside = "“Gel. Otur. Anlat bana her şeyi, baştan sona, hiçbir şeyi saklamadan.” "
        text = ("Kadın bir süre sustu ve sonra bana döndü. " + inside) * 6
        for chunk in chunk_section({"section": 0, "blocks": [block(0, text.strip())]}):
            # No chunk ends between "Gel." and the closing quote.
            self.assertFalse(chunk.text.endswith(("Gel.", "Otur.")))

    def test_the_pause_inside_a_block_follows_its_last_mark(self):
        def pause(text):
            return Chunk(0, 0, 0, 0, len(text), text, heading=False, block_end=False).pause_after

        self.assertEqual(pause("Ne cevap verecektim?"), 0.75)
        self.assertEqual(pause("“Seni gidi çapkın seni!”"), 0.75)
        self.assertEqual(pause("Bilmiyorum..."), 0.95)
        self.assertEqual(pause("Bilmiyorum…"), 0.95)
        self.assertEqual(pause("Ortadan kaybolmuştu."), 0.55)
        self.assertEqual(pause("sonra, birdenbire,"), 0.35)


if __name__ == "__main__":
    unittest.main()
