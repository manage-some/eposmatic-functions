import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import type { Bucket } from "@google-cloud/storage";
import sharp from "sharp";

initializeApp();

const SOURCE_BUCKET = process.env.SOURCE_BUCKET || "dev-managesome.appspot.com";
const VARIANTS_BUCKET =
  process.env.VARIANTS_BUCKET || "dev-managesome-variants";
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "30", 10);

const SIZES = [
  { suffix: "64x64", width: 64, height: 64 },
  { suffix: "128x128", width: 128, height: 128 },
  { suffix: "256x256", width: 256, height: 256 },
  { suffix: "512x512", width: 512, height: 512 },
] as const;

const VARIANT_REGEX = /_\d+x\d+\.webp$/i;
const SKIP_CONTENT_TYPES = new Set(["image/gif", "image/svg+xml"]);

let processed = 0;
let alreadyExisted = 0;
let errors = 0;

/**
 * Process a single image: generate all 4 variant sizes.
 * Returns the number of variants actually created (0-4).
 */
async function processImage(
  filePath: string,
  srcBucket: Bucket,
  dstBucket: Bucket,
): Promise<number> {
  let created = 0;

  // Download
  const [buffer] = await srcBucket.file(filePath).download();

  if (!buffer || buffer.length === 0) {
    return 0;
  }

  const basePath = filePath.replace(/\.[^.]+$/, "");

  const results = await Promise.allSettled(
    SIZES.map(async (size) => {
      const variantPath = `${basePath}_${size.suffix}.webp`;

      // Skip if variant already exists (resumable backfill)
      const [exists] = await dstBucket.file(variantPath).exists();
      if (exists) {
        alreadyExisted++;
        return;
      }

      const resizedBuffer = await sharp(buffer, {
        limitInputPixels: 100_000_000,
      })
        .resize(size.width, size.height, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer();

      await dstBucket.file(variantPath).save(resizedBuffer, {
        metadata: {
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000",
        },
      });

      created++;
    }),
  );

  // Log any size-level failures
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(`  Size failed for ${filePath}:`, result.reason);
    }
  }

  return created;
}

async function main() {
  const storage = getStorage();
  const srcBucket = storage.bucket(SOURCE_BUCKET);
  const dstBucket = storage.bucket(VARIANTS_BUCKET);

  console.log(`Backfilling variants from ${SOURCE_BUCKET} → ${VARIANTS_BUCKET}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log("");

  let pageToken: string | undefined;
  let page = 0;

  do {
    const [files, nextPageToken] = await srcBucket.getFiles({
      autoPaginate: false,
      maxResults: 100,
      pageToken,
    });

    page++;
    console.log(
      `Page ${page}: ${files.length} files listed (created: ${processed}, skipped: ${alreadyExisted}, errors: ${errors})`,
    );

    // Filter to images only (mirrors the live Cloud Function guards)
    const imageFiles = files.filter((file) => {
      const name = file.name;
      const contentType = file.metadata.contentType || "";

      if (!name) return false;
      if (VARIANT_REGEX.test(name)) return false;
      if (!contentType.startsWith("image/")) return false;
      if (SKIP_CONTENT_TYPES.has(contentType)) return false;

      return true;
    });

    if (imageFiles.length === 0) {
      pageToken = nextPageToken as string | undefined;
      continue;
    }

    // Process in parallel batches of CONCURRENCY
    for (let i = 0; i < imageFiles.length; i += CONCURRENCY) {
      const batch = imageFiles.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (file) => {
          const created = await processImage(file.name, srcBucket, dstBucket);
          if (created > 0) processed++;
          return created;
        }),
      );

      // Count hard errors
      for (const r of results) {
        if (r.status === "rejected") {
          errors++;
        }
      }
    }

    pageToken = nextPageToken as string | undefined;
  } while (pageToken);

  console.log("");
  console.log("=== Backfill complete ===");
  console.log(`  Variants created for: ${processed} images`);
  console.log(`  Already existed:       ${alreadyExisted} sizes skipped`);
  console.log(`  Errors:                ${errors}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
