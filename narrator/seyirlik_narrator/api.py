"""The server's side of a narration, as the narrator sees it (narrationRoutes.ts).

Every request carries the narrator key as a bearer token and nothing else.
A refusal comes back as ApiError with the server's code; a network failure
is Unreachable, for the caller to wait out and try again.
"""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Below the server's 32 MiB, and well below the ~100 MB a request through the tunnel can carry.
PART_BYTES = 16 * 1024 * 1024
TIMEOUT = 120


class Unreachable(OSError):
    """The server did not answer: the network, the tunnel or the server is down. Nothing was refused."""


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Job:
    item_id: str
    voice: str
    script_version: int
    # Sections the server already has, by the SHA-256 of their audio.
    uploaded: dict[int, str]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class NarratorApi:
    def __init__(self, server: str, key: str):
        self.base = server.rstrip("/") + "/ownAPI/v1"
        self.key = key

    def _request(self, method: str, path: str, body: bytes | None = None, content_type: str | None = None) -> Any:
        headers = {"Authorization": f"Bearer {self.key}", "Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                detail = json.loads(raw)["error"]
                raise ApiError(error.code, detail.get("code", "ERROR"), detail.get("message", "")) from None
            except (ValueError, KeyError, TypeError):
                raise ApiError(error.code, "HTTP_ERROR", raw[:200].decode("utf-8", "replace")) from None
        except urllib.error.URLError as error:
            raise Unreachable(f"The server could not be reached: {error.reason}") from None
        except (TimeoutError, ConnectionError) as error:
            raise Unreachable(f"The server stopped answering: {error}") from None
        return json.loads(raw)["data"] if raw else None

    def _json(self, method: str, path: str, value: Any) -> Any:
        return self._request(method, path, json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json")

    # -- the calls ------------------------------------------------------------

    def hello(self) -> dict:
        return self._request("GET", "/narrator/hello")

    def claim(self, voice: str) -> Job | None:
        job = self._json("POST", "/narrator/claim", {"voice": voice})["job"]
        if not job:
            return None
        return Job(
            item_id=job["itemId"],
            voice=job["voice"],
            script_version=job["scriptVersion"],
            uploaded={s["section"]: s["audioSha256"] for s in job["sections"]},
        )

    def script(self, item_id: str) -> dict:
        return self._request("GET", f"/narrator/jobs/{item_id}/script")

    def progress(self, item_id: str, report: dict) -> None:
        self._json("POST", f"/narrator/jobs/{item_id}/progress", report)

    def finish(self, item_id: str, ready: bool, error: str | None = None) -> None:
        self._json("POST", f"/narrator/jobs/{item_id}/finish", {"ready": True} if ready else {"ready": False, "error": error})

    def upload_section(self, item_id: str, section: int, audio: Path, timings: dict) -> str:
        """Sends a section's audio in parts, going on from what the server already has, then its words."""
        sha = file_sha256(audio)
        size = audio.stat().st_size
        path = f"/narrator/jobs/{item_id}/sections/{section}"
        for attempt in range(2):
            # Going on from a staged upload only makes sense for this very file;
            # if what is staged was another encoding, the hash check below says so
            # and the second attempt starts over.
            offset = self._request("GET", f"{path}/staged")["size"] if attempt == 0 else 0
            if offset > size:
                offset = 0
            with open(audio, "rb") as f:
                while offset < size:
                    f.seek(offset)
                    part = f.read(PART_BYTES)
                    try:
                        offset = self._request("PUT", f"{path}/audio?offset={offset}", part, "application/octet-stream")["size"]
                    except ApiError as error:
                        if error.code != "NARRATION_PART_OFFSET":
                            raise
                        offset = self._request("GET", f"{path}/staged")["size"]
                        if offset > size:
                            offset = 0
            try:
                self._json("POST", path, {"sha256": sha, "duration": timings["duration"], "words": timings["words"]})
                return sha
            except ApiError as error:
                if error.code != "NARRATION_AUDIO_REJECTED" or attempt == 1:
                    raise
        return sha
