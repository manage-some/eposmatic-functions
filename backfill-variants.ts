import { Storage } from "@google-cloud/storage";
import sharp from "sharp";

const SOURCE_BUCKET = "prod-managesome.appspot.com";
const VARIANTS_BUCKET = "prod-managesome-variants";
const CONCURRENCY = 12;

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

async function processImage(filePath: string): Promise<number> {
  // Guard: skip anything that looks like a directory or listing entry
  if (filePath.endsWith("/") || filePath.endsWith(":")) return 0;

  const basePath = filePath.replace(/\.[^.]+$/, "");

  // Download original to memory via SDK (no temp files, no root-owned dir issues)
  const [buffer] = await sourceBucket.file(filePath).download();
  if (!buffer || buffer.length === 0) {
    return 0;
  }

  // Generate and upload variants one at a time so each buffer is
  // disposed before the next resize
  let created = 0;
  for (const size of SIZES) {
    try {
      const variantExt = filePath.includes(".") ? ".webp" : "";
      const variantPath = `${basePath}_${size.suffix}${variantExt}`;

      const resizedBuffer = await sharp(buffer, {
        limitInputPixels: 100_000_000,
      })
        .resize(size.width, size.height, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer();

      await variantsBucket.file(variantPath).save(resizedBuffer);
      created++;
    } catch {
      // variant failed — skip, continue with next size
    }
  }

  return created;
}

function isImageFile(name: string): boolean {
  if (!name) return false;
  if (name.endsWith("/")) return false;
  if (VARIANT_REGEX.test(name)) return false;
  const hasImageExt = /\.(jpg|jpeg|png|webp|bmp|tiff|tif|avif)$/i.test(name);
  const hasNoExt = !name.includes(".");
  return hasImageExt || hasNoExt;
}

async function listAllImages(): Promise<string[]> {
  // auto-paginated listing of every object under images/
  const [allFiles] = await sourceBucket.getFiles({ prefix: "images/" });
  return allFiles.map((file) => file.name).filter(isImageFile);
}

async function processBatch(
  batch: string[],
): Promise<{ created: number; skipped: number; errors: number }> {
  let created = 0;
  let skipped = 0;
  let errors = 0;

  const results = await Promise.allSettled(
    batch.map(async (gcsPath) => {
      try {
        const count = await processImage(gcsPath);
        if (count > 0) return "created";
        return "skipped";
      } catch (err) {
        console.error(`  Error: ${gcsPath}`, err);
        return "error";
      }
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value === "created") created++;
      else if (r.value === "error") errors++;
      else skipped++;
    } else {
      errors++;
    }
  }

  return { created, skipped, errors };
}

let processed = 0;
let totalSkipped = 0;
let totalErrors = 0;
let totalFiles = 0;

async function main() {
  console.log(
    `Backfilling variants from ${SOURCE_BUCKET} → ${VARIANTS_BUCKET}`,
  );
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log("");

  const startTime = Date.now();

  console.log("Listing images from source bucket...");
  const imagePaths = await listAllImages();
  console.log(`  Found ${imagePaths.length} images to process`);

  // Process in batches
  for (let i = 0; i < imagePaths.length; i += CONCURRENCY) {
    const batch = imagePaths.slice(i, i + CONCURRENCY);
    const { created, skipped, errors } = await processBatch(batch);
    processed += created;
    totalSkipped += skipped;
    totalErrors += errors;
    totalFiles += batch.length;

    console.log(
      `  +${batch.length} files (created: ${processed}, errors: ${totalErrors})`,
    );
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const avgRate = totalTime > 0 ? Math.round(totalFiles / totalTime) : "?";
  console.log("");
  console.log("=== Backfill complete ===");
  console.log(`  Total time:          ${totalTime}s`);
  console.log(`  Average rate:        ${avgRate} files/s`);
  console.log(`  Files processed:     ${totalFiles}`);
  console.log(`  Variants created:    ${processed}`);
  console.log(`  Skipped (empty):     ${totalSkipped}`);
  console.log(`  Errors:              ${totalErrors}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
