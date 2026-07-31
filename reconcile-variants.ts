import { Storage } from "@google-cloud/storage";
import sharp from "sharp";

const SOURCE_BUCKET = "prod-managesome.appspot.com";
const VARIANTS_BUCKET = "prod-managesome-variants";
// Higher concurrency than the original backfill (12) for a faster reconcile run
const CONCURRENCY = 32;

// Uses the VM's default service account (storage-rw scope) — no key file needed
const storage = new Storage();
const sourceBucket = storage.bucket(SOURCE_BUCKET);
const variantsBucket = storage.bucket(VARIANTS_BUCKET);

const SIZES = [
  { suffix: "64x64", width: 64, height: 64 },
  { suffix: "128x128", width: 128, height: 128 },
  { suffix: "256x256", width: 256, height: 256 },
  { suffix: "512x512", width: 512, height: 512 },
] as const;

const VARIANT_REGEX = /_\d+x\d+(\.webp)?$/i;

const IMAGE_EXT_REGEX = /\.(jpg|jpeg|png|webp|bmp|tiff|tif|avif)$/i;

/** Last path segment (the filename). */
function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

/**
 * Whether the FILENAME carries an extension (a dot not at index 0).
 * Looks only at the last segment so dotted directory names (e.g.
 * "thailemon.co.nz") never confuse the check.
 */
function hasExtension(name: string): boolean {
  const dotIndex = lastSegment(name).lastIndexOf(".");
  return dotIndex > 0;
}

/** Strip the extension from the LAST segment only, preserving dotted dirs. */
function stripExtension(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  const dir = slashIndex === -1 ? "" : path.slice(0, slashIndex + 1);
  const filename = slashIndex === -1 ? path : path.slice(slashIndex + 1);
  // A dot at index 0 (e.g. a bare ".webp" name) is not a real extension — keep it
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) return path;
  return dir + filename.slice(0, dotIndex);
}

/** Variant extension: .webp only when the source filename had an extension. */
function variantExt(sourcePath: string): string {
  return hasExtension(sourcePath) ? ".webp" : "";
}

function isImageFile(name: string): boolean {
  if (!name) return false;
  if (name.endsWith("/")) return false;
  if (VARIANT_REGEX.test(name)) return false;
  const filename = lastSegment(name);
  const hasImageExt = IMAGE_EXT_REGEX.test(filename);
  const hasNoExt = !filename.includes(".");
  return hasImageExt || hasNoExt;
}

/** All variant object names a source image would produce. */
function variantPathsFor(sourcePath: string): string[] {
  const basePath = stripExtension(sourcePath);
  const ext = variantExt(sourcePath);
  return SIZES.map((size) => `${basePath}_${size.suffix}${ext}`);
}

async function listAllNames(bucketName: string): Promise<string[]> {
  const names: string[] = [];
  const stream = storage.bucket(bucketName).getFilesStream();
  for await (const file of stream) {
    names.push(file.name);
  }
  return names;
}

/** Generate a source image's variants, skipping sizes that already exist. */
async function processSource(
  sourcePath: string,
  variantNames: Set<string>,
): Promise<number> {
  const [buffer] = await sourceBucket.file(sourcePath).download();
  if (!buffer || buffer.length === 0) {
    return 0;
  }

  const basePath = stripExtension(sourcePath);
  const ext = variantExt(sourcePath);

  let created = 0;
  for (const size of SIZES) {
    const variantPath = `${basePath}_${size.suffix}${ext}`;
    // Skip sizes whose variant already exists — don't overwrite existing work
    if (variantNames.has(variantPath)) {
      continue;
    }
    try {
      const resizedBuffer = await sharp(buffer, {
        limitInputPixels: 100_000_000,
      })
        .resize(size.width, size.height, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer();

      await variantsBucket.file(variantPath).save(resizedBuffer, {
        metadata: {
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000",
        },
      });
      created++;
    } catch {
      // variant failed — skip, continue with next size
    }
  }

  return created;
}

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log(
    `Reconciling variants from ${SOURCE_BUCKET} → ${VARIANTS_BUCKET}`,
  );
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log("");

  console.log("Listing source images (entire bucket)...");
  const sourceNames = await listAllNames(SOURCE_BUCKET);
  const sourceImages = sourceNames.filter(isImageFile);
  console.log(`  Source objects:      ${sourceNames.length}`);
  console.log(`  Source images:       ${sourceImages.length}`);

  console.log("Listing existing variants...");
  const variantNames = new Set(await listAllNames(VARIANTS_BUCKET));
  console.log(`  Existing variants:   ${variantNames.size}`);

  // Find sources missing at least one variant
  const missing: string[] = [];
  let fullyCovered = 0;
  for (const source of sourceImages) {
    const expected = variantPathsFor(source);
    if (expected.some((p) => !variantNames.has(p))) {
      missing.push(source);
    } else {
      fullyCovered++;
    }
  }
  console.log(`  Fully covered:       ${fullyCovered}`);
  console.log(`  Need variants:       ${missing.length}`);
  console.log("");

  // Generate missing in batches
  let generated = 0;
  let empty = 0;
  let errors = 0;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (sourcePath) => {
        try {
          const count = await processSource(sourcePath, variantNames);
          return count > 0 ? "created" : "skipped";
        } catch (err) {
          console.error(`  Error: ${sourcePath}`, err);
          return "error";
        }
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value === "created") generated++;
        else if (r.value === "error") errors++;
        else empty++;
      } else {
        errors++;
      }
    }

    console.log(
      `  +${batch.length} sources (generated: ${generated}, errors: ${errors})`,
    );
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const avgRate = totalTime > 0 ? Math.round(missing.length / totalTime) : "?";
  console.log("");
  console.log("=== Reconcile complete ===");
  console.log(`  Total time:          ${totalTime}s`);
  console.log(`  Average rate:        ${avgRate} files/s`);
  console.log(`  Sources needing work: ${missing.length}`);
  console.log(`  Sources generated:   ${generated}`);
  console.log(`  Skipped (empty):     ${empty}`);
  console.log(`  Errors:              ${errors}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
