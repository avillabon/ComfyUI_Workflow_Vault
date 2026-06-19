// Client-side thumbnail generation. Downscales a picked image to fit within a
// 512x512 box and re-encodes it as a small WebP (JPEG fallback) so the grid
// serves tiny cover images instead of multi-MB workflow outputs.
//
// All work happens in the browser via <canvas>, so the backend keeps its
// zero-dependency footprint (no Pillow). Re-encoding strips metadata by design;
// the untouched original is archived separately (see thumbnail_source).

const THUMB_MAX_DIM = 512;
const THUMB_QUALITY = 0.8; // WebP quality — near-lossless at thumbnail scale
const JPEG_FALLBACK_QUALITY = 0.85;

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob((b) => resolve(b), type, quality);
    else resolve(null);
  });
}

// Some browsers (notably older Safari) ignore image/webp and hand back PNG;
// check the resulting type and fall back to JPEG so the file stays small.
async function encodeSmall(canvas, quality) {
  const webp = await toBlob(canvas, "image/webp", quality);
  if (webp && webp.type === "image/webp") return { blob: webp, ext: "webp" };
  const jpeg = await toBlob(canvas, "image/jpeg", JPEG_FALLBACK_QUALITY);
  if (jpeg) return { blob: jpeg, ext: "jpg" };
  return null;
}

async function loadImage(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file);
    } catch {
      // fall through to the <img> path
    }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

// Captures the currently-displayed frame of a <video> as a small WebP File,
// downscaled to fit within maxDim. Used by the thumbnail picker's "pick a
// frame" path, which runs entirely in the browser (no ffmpeg needed). Returns
// null if the frame can't be read or encoded.
export async function captureVideoFrameFile(video, { maxDim = THUMB_MAX_DIM, quality = THUMB_QUALITY } = {}) {
  const sw = video?.videoWidth || 0;
  const sh = video?.videoHeight || 0;
  if (!sw || !sh) return null;
  const scale = Math.min(1, maxDim / Math.max(sw, sh)); // never upscale
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  try {
    ctx.drawImage(video, 0, 0, w, h);
  } catch {
    return null; // tainted/undecodable frame
  }
  const encoded = await encodeSmall(canvas, quality);
  if (!encoded) return null;
  return new File([encoded.blob], `cover.${encoded.ext}`, { type: encoded.blob.type });
}

// Returns a small File suitable to upload as the display thumbnail. On any
// failure (decode/encode unsupported) it resolves to the original file so a
// thumbnail is always produced.
export async function makeThumbnailFile(file, { maxDim = THUMB_MAX_DIM, quality = THUMB_QUALITY } = {}) {
  if (!file) return file;
  try {
    const src = await loadImage(file);
    const sw = src.naturalWidth || src.width;
    const sh = src.naturalHeight || src.height;
    if (!sw || !sh) {
      src.close?.();
      return file;
    }
    const scale = Math.min(1, maxDim / Math.max(sw, sh)); // never upscale
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(src, 0, 0, w, h);
    src.close?.();

    const encoded = await encodeSmall(canvas, quality);
    if (!encoded) return file;
    return new File([encoded.blob], `cover.${encoded.ext}`, { type: encoded.blob.type });
  } catch {
    return file;
  }
}
