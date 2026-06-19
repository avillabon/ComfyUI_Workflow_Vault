"""Convert a short video (MP4/MOV/WebM) into an animated WebP thumbnail.

ffmpeg does the work; we resolve its binary from imageio-ffmpeg (a bundled,
cross-platform static build — no system install) and fall back to a system
ffmpeg on PATH if present.

The output profile is intentionally hardcoded (no user-facing settings):
fit within a 512px box (never upscaled), 18 fps, only the first 5 seconds, and
an infinite loop — tuned to land around 1-2 MB. The 5-second cap is a guardrail
so dropping a 60-second clip can't produce a giant thumbnail.
"""

import os
import shutil
import subprocess
import tempfile

# Output profile — see module docstring. Hardcoded by design.
MAX_DIM = 512          # fit the longest side within this many pixels
FPS = 18               # frames per second of the looping preview
MAX_SECONDS = 5        # only convert the first N seconds of the source
WEBP_QUALITY = 70      # libwebp quality (0-100); higher = larger/cleaner
COMPRESSION_LEVEL = 6  # libwebp method (0-6); higher = slower/smaller
CONVERT_TIMEOUT = 120  # seconds before we give up on a stuck ffmpeg

VIDEO_EXTS = {"mp4", "mov", "webm"}

_ffmpeg_path = None
_ffmpeg_resolved = False


def is_video_ext(ext):
    return (ext or "").lower() in VIDEO_EXTS


def find_ffmpeg():
    """Return a path to an ffmpeg binary, or None. Resolved once and cached."""
    global _ffmpeg_path, _ffmpeg_resolved
    if _ffmpeg_resolved:
        return _ffmpeg_path
    _ffmpeg_resolved = True

    # Prefer imageio-ffmpeg's bundled static binary — present cross-platform
    # with no system install, and shared with VideoHelperSuite users.
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.exists(exe):
            _ffmpeg_path = exe
            return _ffmpeg_path
    except Exception:  # pragma: no cover - defensive (missing pkg / fetch fail)
        pass

    _ffmpeg_path = shutil.which("ffmpeg")
    return _ffmpeg_path


def ffmpeg_available():
    return find_ffmpeg() is not None


def convert_to_animated_webp(data, src_ext):
    """Convert video bytes to animated-WebP bytes.

    Returns the WebP bytes, or None when ffmpeg is unavailable or the
    conversion fails (callers surface a friendly error)."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None

    # Fit within MAX_DIM box, preserve aspect ratio, and never upscale (the
    # min() caps the target box at the source's own dimensions).
    vf = (
        f"fps={FPS},"
        f"scale='min({MAX_DIM},iw)':'min({MAX_DIM},ih)':"
        f"force_original_aspect_ratio=decrease"
    )

    tmpdir = tempfile.mkdtemp(prefix="wv_thumb_")
    in_path = os.path.join(tmpdir, "in." + ((src_ext or "mp4").lower()))
    out_path = os.path.join(tmpdir, "out.webp")
    try:
        with open(in_path, "wb") as fh:
            fh.write(data)
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-t", str(MAX_SECONDS),   # input option: stop decoding after N seconds
            "-i", in_path,
            "-vf", vf,
            "-an",                    # drop audio
            "-c:v", "libwebp",
            "-lossless", "0",
            "-quality", str(WEBP_QUALITY),
            "-compression_level", str(COMPRESSION_LEVEL),
            "-loop", "0",             # infinite loop
            out_path,
        ]
        proc = subprocess.run(
            cmd, capture_output=True, timeout=CONVERT_TIMEOUT
        )
        if proc.returncode != 0 or not os.path.isfile(out_path):
            return None
        with open(out_path, "rb") as fh:
            return fh.read()
    except Exception:  # pragma: no cover - defensive (timeout / IO / ffmpeg)
        return None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
