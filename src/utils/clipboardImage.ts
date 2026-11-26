import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { t } from "../i18n";

/// An image taken from the system clipboard, already encoded (JPEG, or PNG when it has transparency) so it
/// can travel to the backend as base64 and be written to disk as it is.
export interface ClipboardImage {
  name: string;
  dataBase64: string;
  previewUrl: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/// Named in the interface language at the moment of pasting, so the file name
/// shown under the item matches the language the app is used in.
function clipboardImageName(ext: "png" | "jpg"): string {
  const d = new Date();
  return `${t("diary.clipboardImageNamePrefix")} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${ext}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Lesefehler"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

async function toClipboardImage(blob: Blob): Promise<ClipboardImage> {
  const ext = blob.type === "image/jpeg" ? "jpg" : "png";
  const dataBase64 = await blobToBase64(blob);
  // A data: URL of the bytes already in hand rather than an object URL: the
  // image passes through several components (track menu, choice dialog,
  // diary), none of which owns it, so an object URL was never revoked.
  const previewUrl = `data:${ext === "jpg" ? "image/jpeg" : "image/png"};base64,${dataBase64}`;
  return { name: clipboardImageName(ext), dataBase64, previewUrl };
}

/// An image file the webview handed over in a paste event.
export async function imageFromFile(file: File): Promise<ClipboardImage> {
  const keep = file.type === "image/png" || file.type === "image/jpeg";
  return toClipboardImage(keep ? file : await reencodeAsPng(file));
}

async function reencodeAsPng(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Kein Canvas verfügbar");
  ctx.drawImage(bitmap, 0, 0);
  return canvasToPng(canvas);
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG-Kodierung fehlgeschlagen"))), "image/png");
  });
}

// The clipboard hands over raw pixels. A PNG of a photo is several times the
// size of the JPEG it came from, so an image without any transparency is
// stored as a high-quality JPEG; only images that use alpha stay PNG.
const JPEG_QUALITY = 0.92;

function isOpaque(rgba: Uint8Array | Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return false;
  }
  return true;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("JPEG-Kodierung fehlgeschlagen"))), "image/jpeg", JPEG_QUALITY);
  });
}

/// The image currently on the system clipboard, or `null` when it holds
/// something else (text, files, nothing). Reads the native clipboard through
/// the Tauri plugin first, which does not depend on the webview granting
/// clipboard access; the browser API is only the fallback.
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  try {
    const image = await readImage();
    const [{ width, height }, rgba] = await Promise.all([image.size(), image.rgba()]);
    if (width > 0 && height > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const pixels = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength);
        ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
        return await toClipboardImage(isOpaque(pixels) ? await canvasToJpeg(canvas) : await canvasToPng(canvas));
      }
    }
  } catch {
    // Nothing image-like on the clipboard (the plugin errors in that case).
  }

  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) return await imageFromFile(new File([await item.getType(type)], "clipboard", { type }));
    }
  } catch {
    // Blocked or unsupported — no image to offer.
  }
  return null;
}
