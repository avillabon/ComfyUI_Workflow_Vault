// Best-effort client-side codec sniff for MP4/MOV containers, used to warn
// before upload that a video is H.265/HEVC — Firefox on Windows plays HEVC
// only via a hardware decoder with no software fallback (see vault_dom.js's
// VIDEO_CODEC_HINT for the same caveat on the playback side).
//
// Reads only box headers via File.slice() (local, effectively free regardless
// of file size), walking moov -> trak -> mdia -> minf -> stbl -> stsd to find
// the sample entry's codec fourcc. moov often sits at the END of the file for
// encoders that don't set +faststart, so a "read the first N KB" shortcut
// would miss most real files — this walks by declared box size instead of
// reading sequentially.
//
// Returns "hevc" | "h264" | null. Never throws: any parse failure, unknown
// container (webm, etc.), or corrupt box tree just yields null — silence,
// never a false warning.

const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
const MAX_BOXES = 4000;

async function readBytes(file, offset, length) {
  if (offset < 0 || offset + length > file.size) return null;
  const buf = await file.slice(offset, offset + length).arrayBuffer();
  return buf.byteLength < length ? null : new DataView(buf);
}

function asciiOf(view, offset, length = 4) {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

async function walk(file, start, end, budget) {
  let offset = start;
  while (offset + 8 <= end) {
    if (++budget.count > MAX_BOXES) return null;
    const header = await readBytes(file, offset, 16); // over-read for the size==1 case
    if (!header) return null;
    let size = header.getUint32(0);
    const type = asciiOf(header, 4);
    let bodyStart = offset + 8;
    if (size === 1) {
      if (header.byteLength < 16) return null;
      size = header.getUint32(8) * 2 ** 32 + header.getUint32(12);
      bodyStart = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < 8 || offset + size > end) return null;

    if (CONTAINER_BOXES.has(type)) {
      const found = await walk(file, bodyStart, offset + size, budget);
      if (found) return found;
    } else if (type === "stsd") {
      const entry = await readBytes(file, bodyStart + 8, 8); // skip version/flags(4) + entry_count(4)
      if (entry) {
        const fourcc = asciiOf(entry, 4);
        if (fourcc === "hev1" || fourcc === "hvc1") return "hevc";
        if (fourcc === "avc1" || fourcc === "avc3") return "h264";
      }
    }
    offset += size;
  }
  return null;
}

export async function probeVideoCodec(file) {
  try {
    return await walk(file, 0, file.size, { count: 0 });
  } catch {
    return null;
  }
}
