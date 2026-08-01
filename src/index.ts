import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions";
import type {
  StorageEvent,
  StorageObjectData,
} from "firebase-functions/v2/storage";
import {
  onObjectDeleted,
  onObjectFinalized,
} from "firebase-functions/v2/storage";
import sharp from "sharp";
import {
  describeEncodeMode,
  encodeVariant,
  LARGE_VARIANT_WIDTH,
  SIZES,
  stripExtension,
  VARIANT_REGEX,
  variantExt,
  webpEncodeOptions,
  type SizeConfig,
} from "./variants.js";

initializeApp();

/** The default Firebase Storage bucket to watch. */
const SOURCE_BUCKET = process.env.SOURCE_BUCKET;

/**
 * Content types that should be skipped because sharp
 * cannot produce a useful resize (animated formats lose frames; SVGs
 * are better served in vector form).
 */
const SKIP_CONTENT_TYPES = new Set(["image/gif", "image/svg+xml"]);

/**
 * Derive the variants bucket name from the source bucket.
 * e.g. "dev-managesome.appspot.com" -> "dev-managesome-variants"
 * Can be overridden via VARIANTS_BUCKET env var.
 */
function getVariantsBucket(sourceBucket: string): string {
  const envOverride = process.env.VARIANTS_BUCKET;
  if (envOverride) return envOverride;

  // Strip .appspot.com suffix and append -variants
  return sourceBucket.replace(/\.appspot\.com$/, "-variants");
}

/**
 * Triggered when a new object is created in the default Firebase Storage bucket.
 * Generates WebP variants at configured sizes and saves them to the variants bucket.
 *
 * SAFETY:
 * - Trigger is scoped to SOURCE_BUCKET only — does NOT listen to variants bucket events.
 * - Reads from source bucket (download, exists check).
 * - Writes ONLY to the variants bucket — never modifies the source bucket.
 */
export const generateImageVariants = onObjectFinalized(
  {
    bucket: SOURCE_BUCKET,
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (event: StorageEvent) => {
    const object: StorageObjectData = event.data;
    const filePath = object.name;
    const contentType = object.contentType;

    // Guard: missing file path
    if (!filePath) {
      logger.warn("Received event with empty object name, skipping");
      return;
    }

    // Guard: skip variant outputs (avoids re-trigger loops)
    if (VARIANT_REGEX.test(filePath)) {
      return;
    }

    // Guard: only image content types
    if (!contentType?.startsWith("image/")) {
      logger.debug(
        `Skipping non-image: ${filePath} (${contentType ?? "unknown"})`,
      );
      return;
    }

    // Guard: skip animated formats (sharp loses frames) and SVGs
    if (SKIP_CONTENT_TYPES.has(contentType)) {
      logger.debug(
        `Skipping unsupported content type: ${contentType} for ${filePath}`,
      );
      return;
    }

    const sourceBucket = object.bucket;
    const variantsBucketName = getVariantsBucket(sourceBucket);

    // Guard: never write variants into the source bucket. If the derived
    // variants bucket resolves to the same bucket (e.g. non-.appspot.com
    // source and no VARIANTS_BUCKET override), refuse instead of polluting it.
    if (variantsBucketName === sourceBucket) {
      logger.error(
        `Refusing to generate variants for ${filePath}: variants bucket ${variantsBucketName} is the same as the source bucket. Set VARIANTS_BUCKET or use a *.appspot.com bucket.`,
      );
      return;
    }

    const storage = getStorage();
    const sourceBucketRef = storage.bucket(sourceBucket);
    const variantsBucketRef = storage.bucket(variantsBucketName);

    logger.info(
      `Generating variants for ${filePath} (${contentType}) → ${variantsBucketName}`,
    );

    try {
      // Download the original
      const [buffer] = await sourceBucketRef.file(filePath).download();

      // Guard: non-empty buffer
      if (!buffer || buffer.length === 0) {
        logger.warn(`Empty file, skipping variants for ${filePath}`);
        return;
      }

      // Read the actual source format (header-only, cheap) so we can pick
      // quality-preserving encoder settings for already-compressed inputs.
      const { format } = await sharp(buffer, {
        limitInputPixels: 100_000_000,
      }).metadata();

      logger.info(`Encoding ${filePath} as ${format ?? "unknown"}`);

      // Strip extension from the filename only (preserves dotted dirs)
      const basePath = stripExtension(filePath);

      // Guard: source may have been deleted while we were processing
      // (race condition: upload → function starts → user deletes original)
      const [sourceExists] = await sourceBucketRef.file(filePath).exists();
      if (!sourceExists) {
        logger.warn(
          `Source deleted during processing, skipping variant writes for ${filePath}`,
        );
        return;
      }

      // Generate all variants in parallel (fit: "inside" preserves aspect ratio)
      const results = await Promise.allSettled(
        SIZES.map(async (size: SizeConfig) => {
          // Only append .webp if the original filename had an extension
          const ext = variantExt(filePath);
          const variantPath = `${basePath}_${size.suffix}${ext}`;

          // Preserve source quality; only the largest variant gets a lossy
          // q85 fallback (keeps whichever is smaller) as a safety net.
          const { buffer: resizedBuffer, options: usedOptions } =
            await encodeVariant(
              buffer,
              size,
              webpEncodeOptions(format),
              size.width >= LARGE_VARIANT_WIDTH,
            );

          await variantsBucketRef.file(variantPath).save(resizedBuffer, {
            metadata: {
              contentType: "image/webp",
              cacheControl: object.cacheControl || "public, max-age=31536000",
            },
          });

          logger.info(
            `Created variant: ${variantPath} (${describeEncodeMode(usedOptions)})`,
          );

          return variantPath;
        }),
      );

      // Separate successes from failures
      const succeeded: string[] = [];
      const failed: unknown[] = [];

      for (const result of results) {
        if (result.status === "fulfilled") {
          succeeded.push(result.value);
        } else {
          failed.push(result.reason);
          logger.error(`Failed to create variant`, result.reason);
        }
      }

      // If some variants failed, roll back the successful ones so consumers
      // never see a partial set — they'll fall back to the original via getImageUrl()
      if (failed.length > 0 && succeeded.length > 0) {
        logger.warn(
          `Rolling back ${succeeded.length} variant(s) due to ${failed.length} failure(s) for ${filePath}`,
        );

        await Promise.allSettled(
          succeeded.map(async (path) => {
            try {
              await variantsBucketRef.file(path).delete();
            } catch {
              // 404 or other delete error — non-critical at this point
            }
          }),
        );
      }
    } catch (err) {
      // Log AND rethrow so the invocation is marked failed (visible in the
      // Functions dashboard / error monitoring). Consumers fall back to the
      // original until a retry or backfill regenerates the variants.
      logger.error(`Failed to generate variants for ${filePath}`, err);
      throw err;
    }
  },
);

/**
 * Triggered when an object is deleted from the default Firebase Storage bucket.
 * Cleans up corresponding variants from the variants bucket.
 *
 * SAFETY:
 * - Trigger is scoped to SOURCE_BUCKET only — does NOT listen to variants bucket events.
 * - Reads from source bucket (exists check).
 * - Deletes ONLY from the variants bucket — never modifies the source bucket.
 */
export const cleanupVariants = onObjectDeleted(
  {
    bucket: SOURCE_BUCKET,
    region: "us-central1",
  },
  async (event: StorageEvent) => {
    const object: StorageObjectData = event.data;
    const filePath = object.name;

    // Guard: missing file path
    if (!filePath) {
      logger.warn("Received delete event with empty object name, skipping");
      return;
    }

    // Guard: skip variant deletions
    if (VARIANT_REGEX.test(filePath)) {
      return;
    }

    // Guard: if the source file still exists, this is a replace (overwrite),
    // not a true delete. The finalized trigger will handle variant updates.
    const sourceBucket = object.bucket;
    const storage = getStorage();
    const [replacementExists] = await storage
      .bucket(sourceBucket)
      .file(filePath)
      .exists();
    if (replacementExists) {
      logger.debug(
        `Source still exists (replace), skipping variant cleanup for ${filePath}`,
      );
      return;
    }

    const variantsBucketName = getVariantsBucket(sourceBucket);

    // Guard: never touch the source bucket during cleanup. If the derived
    // variants bucket is the same as the source (no VARIANTS_BUCKET override
    // on a non-.appspot.com bucket), skip rather than delete originals.
    if (variantsBucketName === sourceBucket) {
      logger.error(
        `Refusing to clean up variants for ${filePath}: variants bucket ${variantsBucketName} is the same as the source bucket. Set VARIANTS_BUCKET or use a *.appspot.com bucket.`,
      );
      return;
    }

    const variantsBucketRef = storage.bucket(variantsBucketName);
    const basePath = stripExtension(filePath);

    logger.info(
      `Cleaning up variants for deleted file: ${filePath} from ${variantsBucketName}`,
    );

    // Delete all variant files in parallel (ignore 404s)
    const results = await Promise.allSettled(
      SIZES.map(async (size: SizeConfig) => {
        // Match the same naming logic as generateImageVariants
        const ext = variantExt(filePath);
        const variantPath = `${basePath}_${size.suffix}${ext}`;
        await variantsBucketRef.file(variantPath).delete();
        return variantPath;
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        logger.info(`Deleted variant: ${result.value}`);
      } else {
        // 404 means the variant was never generated — expected
        const reason: unknown = result.reason;
        if (
          reason &&
          typeof reason === "object" &&
          "code" in reason &&
          (reason as Record<string, unknown>).code !== 404
        ) {
          logger.warn(`Failed to delete variant`, reason);
        }
      }
    }
  },
);
