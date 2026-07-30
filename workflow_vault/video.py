"""Video helpers: animated-WebP thumbnails, and re-encoding to browser-safe H.264.

ffmpeg does the work; we resolve its binary from imageio-ffmpeg (a bundled,
cross-platform static build — no system install) and fall back to a system
ffmpeg on PATH if present. Note that imageio-ffmpeg ships ffmpeg ONLY — there is
no ffprobe — so stream inspection parses `ffmpeg -i` output instead.

The thumbnail output profile is intentionally hardcoded (no user-facing
settings): fit within a 512px box (never upscaled), 18 fps, only the first 5
seconds, and an infinite loop — tuned to land around 1-2 MB. The 5-second cap is
a guardrail so dropping a 60-second clip can't produce a giant thumbnail.
"""

import os
import re
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

# --- Browser-safe H.264 re-encode ------------------------------------------
# Browsers differ in what they can decode, and the gap is not small. Firefox on
# Windows plays H.265/HEVC only through a hardware decoder with no software
# fallback, so an HEVC output that plays fine in Chrome shows nothing at all
# there. H.264 in 8-bit yuv420p is the one profile every browser decodes, so
# that's what we convert to.
H264_CRF = 20          # visually near-transparent; lands ~1.5x the HEVC source
H264_PRESET = "medium"
H264_TIMEOUT = 1800    # 30 min — a long 4K clip is slow but must not hang forever

# Matches the codec name in an `ffmpeg -i` stream line, e.g.
#   Stream #0:0[0x1](und): Video: hevc (Main 10) (hev1 / 0x31766568), ...
_VIDEO_STREAM_RE = re.compile(r"^\s*Stream #\d+:\d+.*?: Video: ([A-Za-z0-9_]+)", re.M)

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


def probe_video_codec(path):
    """Return the first video stream's codec name (lowercase), or None.

    imageio-ffmpeg bundles no ffprobe, so this reads the stream summary ffmpeg
    prints to stderr when given an input and no output. That call exits
    non-zero by design ("At least one output file must be specified"), so the
    return code is deliberately ignored.
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg or not os.path.isfile(path):
        return None
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", path], capture_output=True, timeout=60
        )
    except Exception:  # pragma: no cover - defensive (timeout / OS error)
        return None
    match = _VIDEO_STREAM_RE.search(proc.stderr.decode("utf-8", "replace"))
    return match.group(1).lower() if match else None


def convert_to_h264(src_path, dest_path):
    """Re-encode a video to browser-safe H.264 at dest_path.

    Returns (True, None) on success or (False, message). The video is re-encoded
    (lossy) but the container metadata is carried across intact — which matters
    because ComfyUI stores the whole graph in the `workflow`/`prompt` tags, and
    a file that loses them can no longer be dragged back onto the canvas.

    `-map_metadata 0` alone is NOT enough: the mov/mp4 muxer silently drops tags
    it doesn't recognise unless `use_metadata_tags` is also set. Both together
    carry `workflow`/`prompt` through byte-for-byte.

    Audio is copied rather than re-encoded (AAC, Opus and PCM all mux into MP4
    as-is), and `-map 0:a?` keeps the command working on silent clips.
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return False, "Video conversion is unavailable (ffmpeg not found)."

    # Write beside the destination so the rename below stays on one filesystem,
    # and no half-written file is ever visible under the real name.
    tmp_path = dest_path + ".part.mp4"
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", src_path,
        "-map", "0:v", "-map", "0:a?",   # all video + audio; drop data/subtitles
        "-map_metadata", "0",
        "-movflags", "use_metadata_tags",  # required, or custom tags are dropped
        "-c:v", "libx264",
        "-preset", H264_PRESET,
        "-crf", str(H264_CRF),
        "-pix_fmt", "yuv420p",           # 8-bit 4:2:0 — universally decodable
        "-c:a", "copy",
        tmp_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=H264_TIMEOUT)
        if proc.returncode != 0 or not os.path.isfile(tmp_path):
            lines = proc.stderr.decode("utf-8", "replace").strip().splitlines()
            msg = "ffmpeg could not convert this video."
            if lines:
                msg += f" {lines[-1].strip()}"
            return False, msg
        os.replace(tmp_path, dest_path)
        return True, None
    except subprocess.TimeoutExpired:
        return False, "Conversion timed out."
    except OSError as e:
        return False, f"Could not write the converted video: {e}"
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
