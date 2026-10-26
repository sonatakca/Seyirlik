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
        # The model's own sampling unless a voice says otherwise. Boson suggests
        # 0.8 and top-k 50 for cloning; for this narrator that sounded worse to
        # the person listening than 1.0 with no top-k.
        return cls(spec["name"], refs, float(spec.get("temperature", 1.0)), spec.get("top_k"))

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
    """Higgs with the voice's references encoded, and read, once.

    Every prompt opens with the voice's reference clips (about 3,000 tokens for
    `mk`) and ends with the text to say. mlx-audio's batch_generate reads the
    whole prompt for every row of every batch, which was 22 s of a 32 s batch
    of four short lines. Here the clips are read once into a key/value cache,
    and a batch reads only its own texts after them. The decoding loop below is
    batch_generate's (mlx-audio 0.6.1, pinned) from the prefill on.
    """

    def __init__(self, voice: Voice):
        from mlx_audio.lm.models.cache import make_prompt_cache
        from mlx_audio.tts import load

        self.voice = voice
        self.model = load(HIGGS)
        self.sample_rate = self.model.sample_rate
        self.references = [
            {"codes": self.model.encode_reference_audio(str(audio)), "text": text}
            for audio, text in voice.references
        ]
        m = self.model
        refs = m._normalize_references(references=self.references)
        builder = m._prompt_builder
        prompt = builder.build_prompt("", references=refs)
        # Everything before the text: [tts] then each reference's text and audio.
        self._prefix_length = len(prompt.token_ids) - 2
        embeds, _ = m._build_prompt_embeddings("", refs)
        cache = make_prompt_cache(m)
        m.backbone(
            mx.zeros((1, self._prefix_length), dtype=mx.int32),
            cache=cache,
            input_embeddings=embeds[:, : self._prefix_length],
        )
        self._prefix = [(c.state[0][..., : self._prefix_length, :], c.state[1][..., : self._prefix_length, :]) for c in cache]
        mx.eval([array for pair in self._prefix for array in pair])
        self._text_id, self._audio_id = builder.text_id, builder.audio_id

    def say(self, texts: list[str]) -> list[np.ndarray]:
        """One take of each text, generated together: a batch costs little more than one."""
        from mlx_audio.lm.models.cache import BatchKVCache, KVCache
        from mlx_audio.tts.models.higgs_audio_v3.generation import HiggsSamplerState

        m = self.model
        rows, hidden_rows = [], []
        for text in texts:
            ids = [self._text_id, *m._prompt_builder.encode_text(text), self._audio_id]
            row = []
            for keys, values in self._prefix:
                # Exactly the prefix's length, so the first update copies rather
                # than writing into the shared arrays.
                cache = KVCache()
                cache.keys, cache.values, cache.offset = keys, values, self._prefix_length
                row.append(cache)
            hidden = m.backbone(
                mx.zeros((1, len(ids)), dtype=mx.int32),
                cache=row,
                input_embeddings=m._text_embeddings(ids)[None],
            )
            hidden_rows.append(hidden[:, -1, :])
            rows.append(row)
        batch_cache = [BatchKVCache.merge([row[layer] for row in rows]) for layer in range(len(rows[0]))]
        last_hidden_batch = mx.concatenate(hidden_rows, axis=0)
        mx.eval(last_hidden_batch)

        limit = m._resolve_generation_limit(max_new_tokens=None, max_new_frames=None, max_tokens=None)
        states = [
            {"sampler": HiggsSamplerState(num_codebooks=m.config.audio_num_codebooks), "delayed_rows": []}
            for _ in texts
        ]
        active = list(range(len(texts)))
        for _ in range(limit):
            if not active:
                break
            logits_batch = m._audio_logits(last_hidden_batch)
            sampled_rows = m._step_batch_sampler(
                logits_batch,
                [states[index]["sampler"] for index in active],
                temperature=float(self.voice.temperature),
                top_p=None,
                top_k=self.voice.top_k,
            )
            next_active, next_codes, keep_positions = [], [], []
            for position, (index, codes) in enumerate(zip(active, sampled_rows)):
                states[index]["delayed_rows"].append(codes)
                if not states[index]["sampler"].generation_done:
                    keep_positions.append(position)
                    next_active.append(index)
                    next_codes.append(codes)
            if not next_active:
                break
            if len(next_active) != len(active):
                keep = mx.array(keep_positions, dtype=mx.int32)
                for layer_cache in batch_cache:
                    layer_cache.filter(keep)
            next_embed = m._embed_audio_codes(mx.stack(next_codes, axis=0))[:, None, :]
            hidden = m.backbone(
                mx.zeros((len(next_active), 1), dtype=mx.int32),
                cache=batch_cache,
                input_embeddings=next_embed,
            )
            last_hidden_batch = hidden[:, -1, :]
            active = next_active

        takes = []
        for state in states:
            audio = m._apply_fades(m._decode_audio(state["delayed_rows"]), fade_in_ms=30.0, fade_out_ms=15.0)
            mx.eval(audio)
            takes.append(np.array(audio, dtype=np.float32))
        mx.clear_cache()
        return takes


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
