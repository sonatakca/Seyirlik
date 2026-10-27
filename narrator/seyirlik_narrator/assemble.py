"""Joins a section's takes into one recording with natural pauses, and moves word times onto it.

The silence a take already has at its edges counts toward the pause after
it; only what is missing is added. Speech is never trimmed or touched.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

EDGE_WINDOW = 1.3  # seconds of a take's edge looked at for silence


@dataclass(frozen=True)
class Piece:
    wav: Path
    pause_after: float


def edge_silence(samples: np.ndarray, sample_rate: int, trailing: bool) -> float:
    """Seconds of quiet at one edge, from a 12 ms RMS envelope."""
    if samples.ndim == 2:
        samples = samples.mean(axis=1)
    window = max(1, round(sample_rate * 0.012))
    n = len(samples) // window
    if n == 0:
        return 0.0
    rms = np.sqrt(np.mean(samples[: n * window].reshape(n, window) ** 2, axis=1))
    active = np.flatnonzero(rms > max(0.002, float(rms.max()) * 0.035))
    if len(active) == 0:
        return min(len(samples) / sample_rate, EDGE_WINDOW)
    frames = (n - active[-1] - 1) if trailing else active[0]
    return frames * window / sample_rate


def _edge(path: Path, trailing: bool) -> float:
    with sf.SoundFile(path) as f:
        count = min(f.frames, int(EDGE_WINDOW * f.samplerate))
        if trailing:
            f.seek(f.frames - count)
        return edge_silence(f.read(count, dtype="float32"), f.samplerate, trailing)


def join(pieces: list[Piece], out_wav: Path) -> list[float]:
    """Writes the joined recording and returns where each piece starts, in seconds."""
    infos = [sf.info(p.wav) for p in pieces]
    rate = infos[0].samplerate
    if any(i.samplerate != rate or i.channels != 1 for i in infos):
        raise ValueError("takes differ in sample rate or channels")

    starts = []
    position = 0
    tmp = out_wav.with_suffix(".partial.wav")
    with sf.SoundFile(tmp, "w", samplerate=rate, channels=1, format="WAV", subtype="PCM_16") as out:
        for i, piece in enumerate(pieces):
            starts.append(position / rate)
            audio, _ = sf.read(piece.wav, dtype="float32")
            out.write(audio)
            position += len(audio)
            if i == len(pieces) - 1:
                break
            existing = _edge(piece.wav, True) + _edge(pieces[i + 1].wav, False)
            gap = round(max(0.0, piece.pause_after - existing) * rate)
            if gap:
                out.write(np.zeros(gap, dtype="float32"))
                position += gap
    tmp.replace(out_wav)
    return starts


def encode_m4a(wav: Path, out: Path, bitrate: str = "64k") -> None:
    """AAC in an MP4 with its index first, so a browser can seek before it has the whole file."""
    tmp = out.with_suffix(".partial.m4a")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
         "-c:a", "aac_at", "-b:a", bitrate, "-ac", "1", "-movflags", "+faststart", str(tmp)],
        check=True,
    )
    tmp.replace(out)
