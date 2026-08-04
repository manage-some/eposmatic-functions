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
 * Matches filenames ending in one of the known variant suffixes
 * (_64x64, _128x128, _256x256, _512x512), with optional .webp.
 * Restricted to the real sizes so an original named e.g. "foo_300x300"
 * is not mistaken for a variant and skipped forever.
 */
export const VARIANT_REGEX = /_(?:64x64|128x128|256x256|512x512)(\.webp)?$/i;

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
 * Image extensions that count as a real "with-extension" upload for duplicate
 * cleanup purposes. Only these drive the extension-less sibling removal — a
 * dotted folder (e.g. "thailemon.co.nz") or a dotted non-image filename must
 * never trigger a delete.
 */
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|bmp|tiff?|avif)$/i;

/** Whether the LAST path segment carries a real image extension. */
function hasImageExtension(name: string): boolean {
  return IMAGE_EXTENSIONS.test(lastSegment(name));
}

/**
 * Minimal structural type satisfied by both the Firebase Admin and the
 * @google-cloud/storage Bucket APIs (both expose file().exists()/.delete()
 * and file().getMetadata()).
 */
interface BucketFile {
  exists(): Promise<[boolean]>;
  delete(): Promise<unknown>;
  getMetadata(): Promise<
    [
      {
        updated?: string;
        generation?: string | number;
        contentType?: string | null;
      },
      unknown,
    ]
  >;
}

export interface BucketLike {
  file(name: string): BucketFile;
}

/**
 * Clean up the old extension-less duplicate of a newly-uploaded image.
 *
 * Older uploads were stored WITHOUT an extension (e.g. "123"), while the
 * admin panel now stores them WITH one (e.g. "123.webp"). When an old item's
 * image is updated, the new file lands at "123.webp" while the stale "123"
 * remains — two paths for the same image. This deletes the extension-less
 * sibling but ONLY when the with-extension file actually exists, so a file is
 * never removed without a replacement. The sibling's variants need no manual
 * cleanup here: deleting it from the source bucket fires the deployed
 * cleanupVariants trigger, which removes them.
 *
 * Returns true when a duplicate was removed.
 */
export async function removeExtensionlessDuplicate(
  filePath: string,
  sourceBucket: BucketLike,
): Promise<boolean> {
  // Only the WITH-extension form drives cleanup, and only when the extension
  // is a real image extension (so dotted folder/file names never trigger a
  // delete).
  if (!hasImageExtension(filePath)) return false;

  const basePath = stripExtension(filePath);
  if (basePath === filePath) return false;
  // The sibling must be truly extension-less: a multi-dot driver like
  // "123.v2.webp" would otherwise delete the unrelated file "123.v2".
  if (hasExtension(basePath)) return false;

  // CAUTION: only remove the extension-less sibling if the with-extension
  // file (the one that triggered/was listed) truly exists.
  const [withExtExists] = await sourceBucket.file(filePath).exists();
  if (!withExtExists) return false;

  const [duplicateExists] = await sourceBucket.file(basePath).exists();
  if (!duplicateExists) return false;

  // Delete the stale extension-less source file. Its variants are cleaned up
  // by the deployed cleanupVariants trigger that fires on this delete.
  await sourceBucket.file(basePath).delete();

  return true;
}

/** Image extensions that can collide on the same base name. */
const ORIGINAL_EXTENSIONS = [
  "jpeg",
  "jpg",
  "png",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "avif",
] as const;

/**
 * Every possible original file that shares `basePath` (the name before the
 * extension): the extension-less form plus each image extension, all in the
 * same folder. Variants are never included.
 */
function originalSiblingCandidates(basePath: string): Set<string> {
  return new Set([
    basePath,
    ...ORIGINAL_EXTENSIONS.map((ext) => `${basePath}.${ext}`),
  ]);
}

/**
 * Delete every same-base sibling of the just-uploaded image that is STRICTLY
 * OLDER than it, so that only ONE original per base name remains.
 *
 * Two sources can collide on the same base name:
 * - an extension-less file ("123") next to a with-extension one ("123.webp");
 *   and
 * - the SAME base name with a DIFFERENT image extension ("123.webp" next to a
 *   new "123.jpeg"), which happens when an item's image is re-uploaded and the
 *   extension preference changes. Both map to the SAME variant paths, so a
 *   stale sibling's variants clobber the image that was just uploaded — the
 *   "previous image" bug.
 *
 * The file that triggered this run (`filePath`) is NEVER deleted — it is
 * always the source of truth. Siblings are removed ONLY when provably older by
 * timestamp (`updated`, with `generation` as tiebreaker). A sibling that is
 * NEWER than the driver, or whose timestamp cannot be read, is left untouched
 * — precision over completeness, since deleting the wrong file would break
 * client-side image fetches. Non-image siblings (per contentType) are also
 * left untouched.
 *
 * `driverUpdated`/`driverGeneration` come from the trigger event; when omitted
 * they are read from the driver's own metadata (so the function also works
 * outside the trigger).
 *
 * Deleted siblings' variants need no manual cleanup here — the deployed
 * cleanupVariants trigger skips while a same-base image still exists, so the
 * surviving image's (shared) variant paths are never wiped.
 *
 * Returns the paths that were removed.
 */
export async function cleanupStaleSiblings(
  filePath: string,
  sourceBucket: BucketLike,
  driverUpdated?: string | Date,
  driverGeneration?: string | number,
): Promise<string[]> {
  // Only the WITH-extension form drives cleanup, and only when the extension
  // is a real image extension (so dotted folder/file names never trigger a
  // delete).
  if (!hasImageExtension(filePath)) return [];

  const basePath = stripExtension(filePath);
  if (basePath === filePath) return [];

  // Resolve the driver's timestamp: event args preferred, else its metadata.
  let driverTime = driverUpdated ? new Date(driverUpdated).getTime() : NaN;
  let driverGen: number | undefined =
    driverGeneration !== undefined ? Number(driverGeneration) : undefined;
  if (Number.isNaN(driverTime)) {
    const [meta] = await sourceBucket.file(filePath).getMetadata();
    driverTime = meta?.updated ? Date.parse(meta.updated) : NaN;
    driverGen = meta?.generation ? Number(meta.generation) : undefined;
  }
  if (Number.isNaN(driverTime)) return [];

  const candidates = originalSiblingCandidates(basePath);
  candidates.delete(filePath);

  // Probe every candidate IN PARALLEL: existence + metadata + whether it is a
  // strictly-older image sibling that may be deleted. Promise.allSettled keeps
  // each candidate independent: a transient error on one probe (exists or
  // getMetadata rejection) is treated as "cannot verify" and simply never
  // deletes, instead of aborting cleanup for every other sibling.
  const probes = await Promise.allSettled(
    [...candidates].map(async (candidate) => {
      const [exists] = await sourceBucket.file(candidate).exists();
      if (!exists) return { candidate, shouldDelete: false };

      const [meta] = await sourceBucket.file(candidate).getMetadata();

      // Precision: never delete a non-image file that shares the base name.
      if (meta?.contentType && !meta.contentType.startsWith("image/")) {
        return { candidate, shouldDelete: false };
      }

      // Precision: never delete a sibling we cannot prove is older.
      const siblingTime = meta?.updated ? Date.parse(meta.updated) : NaN;
      if (Number.isNaN(siblingTime)) {
        return { candidate, shouldDelete: false };
      }
      const siblingGen = meta?.generation ? Number(meta.generation) : undefined;

      const olderByTime = siblingTime < driverTime;
      const sameTimeOlderGen =
        siblingTime === driverTime &&
        siblingGen !== undefined &&
        driverGen !== undefined &&
        siblingGen < driverGen;

      return { candidate, shouldDelete: olderByTime || sameTimeOlderGen };
    }),
  );

  // Collect only candidates confirmed deletable. Rejected probes (and any
  // probe that decided not to delete) are excluded — never delete on
  // uncertainty.
  const deletable: string[] = [];
  for (const probe of probes) {
    if (probe.status === "fulfilled" && probe.value.shouldDelete) {
      deletable.push(probe.value.candidate);
    }
  }

  // Delete all qualifying siblings IN PARALLEL (best-effort per file; a
  // concurrent delete 404 or transient error must not abort the rest).
  const results = await Promise.allSettled(
    deletable.map((candidate) =>
      sourceBucket.file(candidate).delete().then(() => candidate),
    ),
  );

  const removed: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      removed.push(result.value);
    }
  }

  return removed;
}

/**
 * Whether any original image sharing the same base name as `filePath` still
 * exists in the source bucket (excluding `filePath` itself). Used by the
 * cleanupVariants trigger so that deleting a stale same-base sibling never
 * wipes the variant paths that a surviving same-base image needs.
 */
export async function hasSameBaseOriginal(
  basePath: string,
  excludePath: string,
  sourceBucket: BucketLike,
): Promise<boolean> {
  // Probe every candidate in parallel (exists + content-type check). Used by
  // cleanupVariants to decide whether a same-base original still exists and
  // variant cleanup should be skipped.
  const results = await Promise.allSettled(
    [...originalSiblingCandidates(basePath)]
      .filter((candidate) => candidate !== excludePath)
      .map(async (candidate) => {
        const [exists] = await sourceBucket.file(candidate).exists();
        if (!exists) return false;
        const [meta] = await sourceBucket.file(candidate).getMetadata();
        if (meta?.contentType && !meta.contentType.startsWith("image/")) {
          return false;
        }
        return true;
      }),
  );

  // A REJECTED probe means we cannot rule out a surviving same-base original.
  // cleanupVariants uses this guard to decide whether deleting the (shared)
  // variant paths is safe; when uncertain we must be conservative and report
  // that a sibling exists, so the surviving image's variants are NOT wiped.
  return results.some((result) =>
    result.status === "fulfilled" ? result.value : true,
  );
}

/**
 * The largest variant width. Only this "hero" size gets the lossy q85
 * fallback (see encodeVariant) as a safety net; every other size is encoded
 * to preserve the source quality exactly.
 */
export const LARGE_VARIANT_WIDTH = Math.max(...SIZES.map((s) => s.width));

/**
 * Choose the WebP encoder mode that best preserves the quality that arrived
 * from the admin panel. Quality control is the admin panel's job (client-side
 * compression); this function avoids adding a second lossy generation for
 * every size except the largest "hero", which also gets a lossy q85 safety
 * net (see encodeVariant) so it can never exceed a plain lossy encode.
 *
 * - PNG sources (already lossless): prefer lossless so pixels stay exact
 *   (crisp for graphics/logos/text).
 * - WebP, JPEG, TIFF and any other raster source: near-lossless (lossless
 *   mode + preprocessing) preserves the decoded pixels essentially exactly,
 *   so the only size reduction comes from the smaller dimensions.
 *
 * The hero (largest) variant additionally tries a lossy q85 encode and keeps
 * whichever of the two is SMALLER, so it is never bigger than a plain lossy
 * version even when the source was already aggressively compressed.
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
  if (isLarge) {
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
