import hashlib
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from seyirlik_narrator import api as api_module
from seyirlik_narrator import service
from seyirlik_narrator.api import ApiError, NarratorApi, Unreachable
from seyirlik_narrator.work import WorkDir, write_json

BOOK = "22222222-2222-4222-8222-222222222222"
KEY = "snk_test"
SCRIPT = {
    "version": 1,
    "sections": [
        {"section": 0, "blocks": [{"block": 0, "heading": True, "text": "BİR"}]},
        {"section": 2, "blocks": [{"block": 0, "heading": False, "text": "Pansiyondaki Hollandalı dul."}]},
    ],
}


class FakeServer:
    """The narrator routes' rules (narrationRoutes.ts), in memory: parts must follow, audio must match its hash."""

    def __init__(self):
        self.staged: dict[int, bytearray] = {}
        self.sections: dict[int, str] = {}
        self.progress: list[dict] = []
        self.finished: list[dict] = []
        self.held = True
        self.job_given = False
        self.parts: list[tuple[int, int, int]] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, status, data=None, code=None):
                body = json.dumps({"error": {"code": code, "message": code}} if code else {"data": data}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _body(self):
                return self.rfile.read(int(self.headers.get("Content-Length") or 0))

            def _route(self, method):
                if self.headers.get("Authorization") != f"Bearer {KEY}":
                    return self._send(401, code="NARRATOR_KEY_REQUIRED")
                path = self.path.removeprefix("/ownAPI/v1")
                body = self._body()
                if path == "/narrator/hello":
                    return self._send(200, {"label": "Test Mac", "scriptVersion": 1})
                if path == "/narrator/claim":
                    if server.job_given:
                        return self._send(200, {"job": None})
                    server.job_given = True
                    sections = [{"section": n, "audioSha256": s} for n, s in server.sections.items()]
                    return self._send(200, {"job": {"itemId": BOOK, "voice": "mk", "scriptVersion": 1, "sections": sections}})
                prefix = f"/narrator/jobs/{BOOK}"
                if not server.held:
                    return self._send(409, code="NARRATION_NOT_HELD")
                if path == f"{prefix}/script":
                    return self._send(200, SCRIPT)
                if path == f"{prefix}/progress":
                    server.progress.append(json.loads(body))
                    return self._send(204)
                if path == f"{prefix}/finish":
                    server.finished.append(json.loads(body))
                    return self._send(204)
                section_path = path.removeprefix(f"{prefix}/sections/")
                number, _, rest = section_path.partition("/")
                number = int(number.split("?")[0])
                if rest == "staged":
                    return self._send(200, {"size": len(server.staged.get(number, b""))})
                if rest.startswith("audio?offset="):
                    offset = int(rest.split("=")[1])
                    current = server.staged.setdefault(number, bytearray())
                    if offset == 0:
                        current.clear()
                    elif offset != len(current):
                        return self._send(409, code="NARRATION_PART_OFFSET")
                    current.extend(body)
                    server.parts.append((number, offset, len(body)))
                    return self._send(200, {"size": len(current)})
                if rest == "" and method == "POST":
                    sent = json.loads(body)
                    if hashlib.sha256(bytes(server.staged.get(number, b""))).hexdigest() != sent["sha256"]:
                        return self._send(422, code="NARRATION_AUDIO_REJECTED")
                    server.sections[number] = sent["sha256"]
                    server.staged.pop(number, None)
                    return self._send(200, {"section": number, "sha256": sent["sha256"]})
                return self._send(404, code="NOT_FOUND")

            def do_GET(self):
                self._route("GET")

            def do_POST(self):
                self._route("POST")

            def do_PUT(self):
                self._route("PUT")

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.http.server_address[1]}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def close(self):
        self.http.shutdown()
        self.http.server_close()


def fake_narrate(audio_for):
    """Writes a section's audio and words as Narration.assemble does, without the models."""
    narrated = []

    def narrate(section, work: WorkDir, progress):
        number = section["section"]
        narrated.append(number)
        progress({"type": "progress", "fraction": 0.5, "etaSeconds": 30})
        work.section(number, ".m4a").write_bytes(audio_for(number))
        write_json(work.section(number, ".words.json"), {"version": 1, "section": number, "duration": 2.0, "words": [[0, 0, 3, 0, 500]], "review": []})

    return narrate, narrated


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.server = FakeServer()
        self.root = Path(tempfile.mkdtemp())
        (self.root / "voices" / "mk").mkdir(parents=True)
        (self.root / "voices" / "mk" / "voice.json").write_text("{}")
        patches = [
            mock.patch.object(api_module, "PART_BYTES", 1000),
            mock.patch.object(service, "STATE", self.root / "state.json"),
            mock.patch.object(service, "HEARTBEAT_SECONDS", 0.05),
            mock.patch.object(service.subprocess, "Popen", mock.MagicMock()),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self.server.close)
        self.api = NarratorApi(self.server.url, KEY)

    def serve(self, narrate):
        service.serve(self.api, "mk", self.root / "voices", self.root / "work", narrate=narrate, once=True)

    def test_reads_a_book_and_uploads_each_section_in_parts(self):
        audio = {0: b"\x00" * 2500, 2: b"\x01" * 900}
        narrate, narrated = fake_narrate(lambda n: audio[n])
        self.serve(narrate)

        self.assertEqual(narrated, [0, 2])
        self.assertEqual(self.server.sections, {n: hashlib.sha256(a).hexdigest() for n, a in audio.items()})
        # 2500 bytes go up as three parts of at most 1000.
        self.assertEqual([p for p in self.server.parts if p[0] == 0], [(0, 0, 1000), (0, 1000, 1000), (0, 2000, 500)])
        self.assertEqual(self.server.finished, [{"ready": True}])
        self.assertEqual(self.server.progress[-1]["sectionsDone"], 2)
        self.assertEqual(self.server.progress[-1]["fraction"], 1.0)

    def test_goes_on_from_what_the_server_already_has(self):
        audio = {0: b"\x00" * 2500, 2: b"\x02" * 2500}
        work = WorkDir(self.root / "work" / BOOK)
        work.section(0, ".m4a").write_bytes(audio[0])
        write_json(work.section(0, ".words.json"), {"duration": 2.0, "words": []})
        self.server.sections[0] = hashlib.sha256(audio[0]).hexdigest()
        # Half of section 2 was sent before a stop.
        self.server.staged[2] = bytearray(audio[2][:1000])
        narrate, narrated = fake_narrate(lambda n: audio[n])
        self.serve(narrate)

        self.assertEqual(narrated, [2])
        self.assertEqual([p for p in self.server.parts if p[0] == 2], [(2, 1000, 1000), (2, 2000, 500)])
        self.assertEqual(self.server.finished, [{"ready": True}])

    def test_starts_an_upload_over_when_what_was_staged_was_another_take(self):
        self.server.staged[0] = bytearray(b"\x09" * 1000)
        narrate, _ = fake_narrate(lambda n: b"\x00" * 2500)
        self.serve(narrate)

        self.assertEqual(self.server.sections[0], hashlib.sha256(b"\x00" * 2500).hexdigest())
        self.assertEqual(self.server.finished, [{"ready": True}])

    def test_stops_a_book_taken_away_and_never_calls_it_finished(self):
        def narrate(section, work, progress):
            self.server.held = False
            progress({"type": "progress", "fraction": 0.1, "etaSeconds": None})
            # The heartbeat is told the book is gone; the next report stops the reading.
            for _ in range(100):
                try:
                    progress({"type": "progress", "fraction": 0.2, "etaSeconds": None})
                except service.Lost:
                    raise
                threading.Event().wait(0.01)
            self.fail("the reading went on")

        self.serve(narrate)
        self.assertEqual(self.server.finished, [])

    def test_says_why_a_book_could_not_be_read(self):
        def narrate(section, work, progress):
            raise RuntimeError("ffmpeg is missing")

        self.serve(narrate)
        self.assertEqual(self.server.finished, [{"ready": False, "error": "RuntimeError: ffmpeg is missing"}])

    def test_waits_out_a_server_it_cannot_reach(self):
        narrate, narrated = fake_narrate(lambda n: b"\x00" * 10)
        real_claim = self.api.claim
        calls = []

        def claim(voice):
            calls.append(voice)
            if len(calls) == 1:
                raise Unreachable("down")
            return real_claim(voice)

        with mock.patch.object(self.api, "claim", claim), mock.patch.object(service.time, "sleep"):
            self.serve(narrate)
        self.assertEqual(narrated, [0, 2])

    def test_refuses_a_wrong_key(self):
        with self.assertRaises(ApiError) as caught:
            NarratorApi(self.server.url, "snk_wrong").hello()
        self.assertEqual(caught.exception.code, "NARRATOR_KEY_REQUIRED")


if __name__ == "__main__":
    unittest.main()
