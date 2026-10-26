"""The three models a narration needs, loaded once and kept for the whole run.

Loading Higgs takes most of a minute and nine gigabytes; a run that loaded it
per sentence (as the first experiments did) spent much of its time doing that.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import mlx.core as mx
import numpy as np
from scipy.signal import resample_poly

from .align import MMS_SAMPLE_RATE

HIGGS = "bosonai/higgs-audio-v3-tts-4b"
MMS = "facebook/mms-1b-all"
WHISPER = "mlx-community/whisper-large-v3-turbo-asr-fp16"
LANGUAGE = "tur"


@dataclass(frozen=True)
class Voice:
    """A narrator's voice: reference clips and the exact words spoken in each."""

    name: str
    references: list[tuple[Path, str]]
    temperature: float
    top_k: int | None

    @classmethod
    def load(cls, directory: Path) -> "Voice":
        spec = json.loads((directory / "voice.json").read_text("utf-8"))
        refs = [(directory / r["audio"], r["text"].strip()) for r in spec["references"]]
        for audio, text in refs:
            if not audio.is_file():
                raise FileNotFoundError(f"reference {audio} is missing")
            if len(text.split()) < 4:
                raise ValueError(f"reference {audio.name} needs the words spoken in it")
        return cls(spec["name"], refs, float(spec.get("temperature", 0.8)), spec.get("top_k", 50))

    def fingerprint(self) -> dict:
        import hashlib

        return {
            "name": self.name,
            "references": [
                [hashlib.sha256(a.read_bytes()).hexdigest()[:16], t] for a, t in self.references
            ],
            "temperature": self.temperature,
            "top_k": self.top_k,
        }


class Speaker:
    """Higgs with the voice's references encoded once."""

    def __init__(self, voice: Voice):
        from mlx_audio.tts import load

        self.voice = voice
        self.model = load(HIGGS)
        self.sample_rate = self.model.sample_rate
        self.references = [
            {"codes": self.model.encode_reference_audio(str(audio)), "text": text}
            for audio, text in voice.references
        ]

    def say(self, texts: list[str]) -> list[np.ndarray]:
        """One take of each text, generated together: a batch costs little more than one."""
        takes: list[np.ndarray | None] = [None] * len(texts)
        results = self.model.batch_generate(
            texts=texts,
            references=self.references,
            temperature=self.voice.temperature,
            top_k=self.voice.top_k,
        )
        for result in results:
            takes[result.sequence_idx] = np.array(result.audio, dtype=np.float32)
        mx.clear_cache()
        return [t if t is not None else np.zeros(0, dtype=np.float32) for t in takes]


class Listener:
    """MMS with its Turkish adapter, for frame-level character scores, and Whisper, for what was heard."""

    def __init__(self):
        from huggingface_hub import snapshot_download
        from mlx_audio.stt import load

        # Only the base model and one language: the repository holds over a thousand
        # adapters (11 GB), and loading it by name downloads every one of them.
        files = [
            "config.json", "preprocessor_config.json", "tokenizer_config.json",
            "special_tokens_map.json", "vocab.json", "model.safetensors",
            f"adapter.{LANGUAGE}.safetensors",
        ]
        self.mms = load(MMS, allow_patterns=files)
        path = Path(snapshot_download(MMS, allow_patterns=files))
        # mlx-audio loads the first adapter it finds and the English vocabulary; be explicit.
        adapter = mx.load(str(path / f"adapter.{LANGUAGE}.safetensors"))
        self.mms.load_weights(list(self.mms.sanitize(adapter).items()), strict=False)
        self.vocab: dict[str, int] = json.loads((path / "vocab.json").read_text("utf-8"))[LANGUAGE]
        self.blank = self.vocab["<pad>"]
        self.separator = self.vocab["|"]
        self.whisper = load(WHISPER)

    def log_probs(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        """(frames, characters) log-probabilities for a take."""
        audio16 = resample_poly(audio, MMS_SAMPLE_RATE, sample_rate).astype(np.float32)
        x = mx.array(audio16)[None, :]
        x = (x - mx.mean(x, axis=-1, keepdims=True)) / (mx.std(x, axis=-1, keepdims=True) + 1e-7)
        logits = self.mms(x)[0]
        out = np.array(logits - mx.logsumexp(logits, axis=-1, keepdims=True), dtype=np.float64)
        mx.clear_cache()
        return out

    def hear(self, audio: np.ndarray, sample_rate: int) -> str:
        audio16 = resample_poly(audio, 16_000, sample_rate).astype(np.float32)
        return self.whisper.generate(mx.array(audio16), language="tr").text.strip()
