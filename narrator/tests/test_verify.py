import unittest

from seyirlik_narrator.align import TimedWord
from seyirlik_narrator.verify import judge

BOOK = (
    "Ekseriya, Alman kızlarıyla ne gibi maceralarım olduğunu öğrenmeye kalkar, ben hakikati söyleyince, "
    "“Seni gidi çapkın seni!” manasına gelen çok bilmiş bir gülümseme ile şahadetparmağını sallar ve "
    "gözlerini süzerdi. Bir gün öğleden sonra beraber dolaşmayı teklif etmiş, akşamüzeri eve dönerken "
    "ısrar ederek beni bir birahaneye sokmuştu."
)
# What Whisper wrote for a take that said every word: it joins and splits words its own way.
HEARD_ALL = (
    "Ekseriya, Alman kızlarıyla ne gibi maceralarım olduğunu öğrenmeye kalkar, ben hakikati söyleyince, "
    "seni gidi çapkın seni, manasına gelen çok bilmiş bir gülümsemeyle şahadet parmağını sallar ve "
    "gözlerini süzerdi. Bir gün öğleden sonra beraber dolaşmayı teklif etmiş, akşam üzeri eve dönerken "
    "ısrar ederek beni bir birahaneye sokmuştu."
)


def sure(n=3):
    return [TimedWord(0, 1, 0.0, 0.1, 0.99)] * n


class JudgeTest(unittest.TestCase):
    def test_accepts_a_complete_take_whatever_way_whisper_spaces_its_words(self):
        verdict = judge(BOOK, HEARD_ALL, sure(), seconds=24.0)
        self.assertTrue(verdict.accepted, verdict)

    def test_refuses_a_take_that_skipped_a_phrase(self):
        heard = HEARD_ALL.replace("Bir gün öğleden sonra beraber ", "")
        verdict = judge(BOOK, heard, sure(), seconds=22.0)
        self.assertFalse(verdict.accepted)
        self.assertIn("skipped-words", verdict.reasons())

    def test_refuses_a_take_with_a_garbled_word(self):
        words = sure(5) + [TimedWord(0, 5, 1.0, 1.5, 0.001)]
        verdict = judge(BOOK, HEARD_ALL, words, seconds=24.0)
        self.assertEqual(verdict.unsure, [5])
        self.assertEqual(verdict.reasons(), ["pronunciation"])

    def test_refuses_a_take_far_too_long_for_its_text(self):
        verdict = judge("Sokuldum.", "Sokuldum.", sure(1), seconds=9.0)
        self.assertFalse(verdict.rate_ok)
        self.assertTrue(judge("Sokuldum.", "Sokuldum.", sure(1), seconds=1.4).rate_ok)


if __name__ == "__main__":
    unittest.main()
