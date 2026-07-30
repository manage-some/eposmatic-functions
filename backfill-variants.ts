import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
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
let skipped = 0;
let errors = 0;

async function processImage(
  filePath: string,
  contentType: string,
  srcBucket: ReturnType<ReturnType<typeof getStorage>["bucket"]>,
  dstBucket: ReturnType<ReturnType<typeof getStorage>["bucket"]>,
) {
  // Download
  const [buffer] = await srcBucket.file(filePath).download();

  if (!buffer || buffer.length === 0) {
    skipped++;
    return;
  }

  const basePath = filePath.replace(/\.[^.]+$/, "");

  await Promise.allSettled(
    SIZES.map(async (size) => {
      const variantPath = `${basePath}_${size.suffix}.webp`;

      // Skip if variant already exists
      const [exists] = await dstBucket.file(variantPath).exists();
      if (exists) return;

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
    }),
  );
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
      `Page ${page}: ${files.length} files (processed: ${processed}, skipped: ${skipped}, errors: ${errors})`,
    );

    // Filter to images only
    const imageFiles = files.filter((file) => {
      const name = file.name;
      const contentType = file.metadata.contentType || "";

      if (!name) return false;
      if (VARIANT_REGEX.test(name)) return false;
      if (!contentType.startsWith("image/")) return false;
      if (SKIP_CONTENT_TYPES.has(contentType)) return false;

      return true;
    });

    // Process in parallel batches
    const batchSize = Math.min(CONCURRENCY, imageFiles.length);
    for (let i = 0; i < imageFiles.length; i += batchSize) {
      const batch = imageFiles.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.map(async (file) => {
          try {
            await processImage(
              file.name,
              file.metadata.contentType || "image/jpeg",
              srcBucket,
              dstBucket,
            );
            processed++;
          } catch (err) {
            errors++;
            console.error(`Error processing ${file.name}:`, err);
          }
        }),
      );
    }

    pageToken = nextPageToken;
  } while (pageToken);

  console.log("");
  console.log(`Done! Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors}`);
}

main().catch(console.error);
