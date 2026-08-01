import sharp from "sharp";

/**
 * Variant sizes to generate.
 * Each entry defines the output dimensions and filename suffix.
 */
export const SIZES = [
  { suffix: "64x64", width: 64, height: 64 },
  { suffix: "128x128", width: 128, height: 128 },
  { suffix: "256x256", width: 256, height: 256 },
  { suffix: "512x512", width: 512, height: 512 },
] as const;

/**
 * Regex to detect files that are already variants.
 * Matches filenames ending in _{digits}x{digits}.webp
 */
export const VARIANT_REGEX = /_\d+x\d+(\.webp)?$/i;

/** Size entry with typed fields. */
export interface SizeConfig {
  readonly suffix: string;
  readonly width: number;
  readonly height: number;
}

/** Last path segment (the filename). */
export function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

/**
 * Whether the FILENAME carries an extension (a dot not at index 0).
 * Looks only at the last segment so dotted directory names (e.g.
 * "thailemon.co.nz") never confuse the check.
 */
export function hasExtension(name: string): boolean {
  const dotIndex = lastSegment(name).lastIndexOf(".");
  return dotIndex > 0;
}

/** Strip the extension from the LAST segment only, preserving dotted dirs. */
export function stripExtension(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  const dir = slashIndex === -1 ? "" : path.slice(0, slashIndex + 1);
  const filename = slashIndex === -1 ? path : path.slice(slashIndex + 1);
  // A dot at index 0 (e.g. a bare ".webp" name) is not a real extension — keep it
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) return path;
  return dir + filename.slice(0, dotIndex);
}

/** Variant extension: .webp only when the source filename had an extension. */
export function variantExt(sourcePath: string): string {
  return hasExtension(sourcePath) ? ".webp" : "";
}

/**
 * The largest variant width. Only this "hero" size gets the lossy q85
 * fallback (see encodeVariant) as a safety net; every other size is encoded
 * to preserve the source quality exactly.
 */
export const LARGE_VARIANT_WIDTH = Math.max(...SIZES.map((s) => s.width));

/**
 * Choose WebP encoder settings that PRESERVE the quality that arrived from
 * the admin panel. Quality control is the admin panel's job (client-side
 * compression); this function never adds a second lossy generation.
 *
 * - PNG sources (already lossless): keep lossless so pixels stay exact
 *   (crisp for graphics/logos/text at every size).
 * - WebP, JPEG, TIFF and any other raster source: near-lossless (lossless
 *   mode + preprocessing) preserves the decoded pixels essentially exactly,
 *   so the only size reduction comes from the smaller dimensions.
 *
 * The largest variant additionally keeps a lossy q85 fallback so it can
 * never exceed a plain lossy encode (see encodeVariant).
 */
export function webpEncodeOptions(
  format: string | undefined,
): sharp.WebpOptions {
  if (format === "png") {
    // PNG is already lossless — preserve pixels exactly.
    return { lossless: true, effort: 6 };
  }
  // WebP/JPEG/TIFF/etc. — near-lossless preserves the source, no 2nd lossy pass.
  return { nearLossless: true, effort: 6 };
}

/** Human-readable description of the active encoder mode (for logging). */
export function describeEncodeMode(options: sharp.WebpOptions): string {
  if (options.lossless) return "lossless";
  if (options.nearLossless) return "near-lossless";
  return `lossy q${options.quality ?? 80}`;
}

/**
 * Encode a single resized variant as WebP and return the buffer plus the
 * encoder options that were actually used.
 *
 * For the LARGEST variant only, it ALSO encodes a lossy q85 version and
 * keeps whichever is SMALLER. This safety net guarantees the "hero" variant
 * never exceeds a plain lossy encode — which can happen when a source was
 * already aggressively compressed (near-lossless preserves those artifacts,
 * making them incompressible). All smaller variants encode purely in the
 * quality-preserving mode.
 */
export async function encodeVariant(
  buffer: Buffer,
  size: SizeConfig,
  preferred: sharp.WebpOptions,
  isLarge: boolean,
): Promise<{ buffer: Buffer; options: sharp.WebpOptions }> {
  const candidates: sharp.WebpOptions[] = [preferred];
  if (isLarge && preferred.nearLossless) {
    candidates.push({ quality: 85, effort: 6, smartSubsample: true });
  }

  const encoded = await Promise.all(
    candidates.map((options) =>
      sharp(buffer, { limitInputPixels: 100_000_000 })
        .resize(size.width, size.height, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp(options)
        .toBuffer(),
    ),
  );

  // Keep the smallest buffer; ties resolve to the preferred (quality) one.
  let best = 0;
  for (let i = 1; i < encoded.length; i++) {
    if (encoded[i].length < encoded[best].length) best = i;
  }
  return { buffer: encoded[best], options: candidates[best] };
}
