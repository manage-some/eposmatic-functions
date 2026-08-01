import { Storage } from "@google-cloud/storage";
import PQueue from "p-queue";
import { Piscina } from "piscina";
import {
  SIZES,
  VARIANT_REGEX,
  hasExtension,
  lastSegment,
  removeExtensionlessDuplicate,
  stripExtension,
  variantExt,
} from "./src/variants.js";

const SOURCE_BUCKET = "prod-managesome.appspot.com";
const VARIANTS_BUCKET = "prod-managesome-variants";
const CONCURRENCY = 24;

// Number of encode worker threads. Each worker runs sharp.concurrency(1) (see
// backfill-worker.ts), so WORKERS == vCPUs to use all cores without
// oversubscription.
const WORKERS = 8;

// Uses the VM's default service account (storage-rw scope) — no key file needed
const storage = new Storage();
const sourceBucket = storage.bucket(SOURCE_BUCKET);
const variantsBucket = storage.bucket(VARIANTS_BUCKET);

// Worker-thread pool: heavy sharp encodes run here so the main thread can keep
// doing GCS I/O (download/upload/exists) while the CPUs stay busy.
const pool = new Piscina({
  filename: new URL("./backfill-worker.ts", import.meta.url).href,
  maxThreads: WORKERS,
});

type ProcessImageResult = {
  outcome: "created" | "skipped" | "failed";
  count: number;
};

async function processImage(filePath: string): Promise<ProcessImageResult> {
  // Guard: skip anything that looks like a directory or listing entry
  if (filePath.endsWith("/") || filePath.endsWith(":")) {
    return { outcome: "skipped", count: 0 };
  }

  // Clean up the old extension-less duplicate of this image (if any). The
  // with-extension file drives the cleanup; the stale extension-less sibling
  // and its variants get deleted. Best-effort — failures must not abort the
  // rest of the backfill.
  if (hasExtension(filePath)) {
    try {
      const removed = await removeExtensionlessDuplicate(
        filePath,
        sourceBucket,
      );
      if (removed) {
        console.log(`  Removed extension-less duplicate of ${filePath}`);
      }
    } catch (err) {
      console.error(
        `  Extension-less duplicate cleanup failed for ${filePath}:`,
        err,
      );
    }
  }

  const basePath = stripExtension(filePath);

  // A with-extension file drives the duplicate cleanup and is never removed by
  // it, so it must still exist. Only an extension-less file can have been
  // deleted as a stale sibling by an earlier with-extension file — check those
  // and skip cleanly instead of erroring on download.
  if (!hasExtension(filePath)) {
    const [fileExists] = await sourceBucket.file(filePath).exists();
    if (!fileExists) return { outcome: "skipped", count: 0 };
  }

  // Download original to memory via SDK (no temp files, no root-owned dir issues)
  const [buffer] = await sourceBucket.file(filePath).download();
  if (!buffer || buffer.length === 0) {
    return { outcome: "skipped", count: 0 };
  }

  // Encode all 4 variants on a piscina worker thread (CPU), then upload them
  // in parallel (I/O). The main thread stays free for GCS while workers encode.
  let created = 0;
  const succeededPaths: string[] = [];
  const ext = variantExt(filePath);
  const variantPaths = SIZES.map((size) => `${basePath}_${size.suffix}${ext}`);

  // Worker returns Uint8Array (structured clone of the worker's Buffers).
  let buffers: Uint8Array[] = [];
  try {
    buffers = (await pool.run(buffer)) as Uint8Array[];
  } catch (err) {
    console.error(`  Encode failed for ${filePath}:`, err);
    return { outcome: "failed", count: 0 };
  }

  if (buffers.length !== variantPaths.length) {
    console.error(
      `  Worker returned ${buffers.length} variant(s) for ${filePath} (expected ${variantPaths.length})`,
    );
    return { outcome: "failed", count: 0 };
  }

  const uploads = await Promise.allSettled(
    variantPaths.map(async (variantPath, index) => {
      await variantsBucket.file(variantPath).save(buffers[index], {
        metadata: {
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000",
        },
      });
      return variantPath;
    }),
  );

  for (const result of uploads) {
    if (result.status === "fulfilled") {
      succeededPaths.push(result.value);
      created++;
    } else {
      console.error(
        `  Variant upload failed for ${filePath}:`,
        result.reason,
      );
    }
  }
  const failedCount = variantPaths.length - created;

  // Roll back partial sets so consumers never see a partial group — they
  // fall back to the original via getImageUrl().
  if (failedCount > 0 && succeededPaths.length > 0) {
    console.warn(
      `  Rolling back ${succeededPaths.length} variant(s) for ${filePath} after ${failedCount} failure(s)`,
    );
    await Promise.allSettled(
      succeededPaths.map(async (path) => {
        try {
          await variantsBucket.file(path).delete();
        } catch {
          // 404 or other delete error — non-critical at this point
        }
      }),
    );
    return { outcome: "failed", count: 0 };
  }

  // The source can be deleted while its variants were being written —
  // externally, or by a concurrent with-extension sibling cleanup deleting
  // a stale extension-less file. cleanupVariants may then have run BEFORE
  // these writes landed, leaving orphans no future event would ever clean.
  // If the source is gone, remove what we just wrote (harmless 404s if the
  // trigger already did).
  if (created > 0) {
    const [stillExists] = await sourceBucket.file(filePath).exists();
    if (!stillExists) {
      console.warn(
        `  Source ${filePath} deleted during processing — removing ${created} orphaned variant(s)`,
      );
      await Promise.allSettled(
        succeededPaths.map((path) => variantsBucket.file(path).delete()),
      );
      return { outcome: "skipped", count: 0 };
    }
  }

  return { outcome: "created", count: created };
}

function isImageFile(name: string): boolean {
  if (!name) return false;
  if (name.endsWith("/")) return false;
  if (VARIANT_REGEX.test(name)) return false;
  const filename = lastSegment(name);
  const hasImageExt = /\.(jpg|jpeg|png|webp|bmp|tiff|tif|avif)$/i.test(
    filename,
  );
  const hasNoExt = !filename.includes(".");
  return hasImageExt || hasNoExt;
}

async function listAllImages(): Promise<string[]> {
  // auto-paginated listing of the ENTIRE bucket (images/, platforms/, rider-app/, ...)
  const [allFiles] = await sourceBucket.getFiles();
  return allFiles
    .map((file) => file.name)
    .filter(isImageFile)
    .sort((a, b) => {
      // Process WITH-extension files first so their duplicate cleanup runs
      // before the extension-less sibling is reached (avoids generating
      // variants for a file that is about to be deleted).
      const aExt = hasExtension(a) ? 1 : 0;
      const bExt = hasExtension(b) ? 1 : 0;
      return bExt - aExt || a.localeCompare(b);
    });
}

async function main() {
  console.log(
    `Backfilling variants from ${SOURCE_BUCKET} → ${VARIANTS_BUCKET}`,
  );
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log("");

  const startTime = Date.now();

  console.log("Listing images from entire source bucket...");
  const imagePaths = await listAllImages();
  console.log(`  Found ${imagePaths.length} images to process`);

  // Process through a concurrency-limited queue instead of fixed batches.
  // Batching waits for the slowest file in every batch; the queue keeps the
  // pipe full — as soon as one image finishes, the next starts immediately
  // (FIFO, so with-extension files still get processed first).
  const queue = new PQueue({ concurrency: CONCURRENCY });

  let filesWithVariants = 0;
  let totalVariants = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let completed = 0;

  const run = async (filePath: string): Promise<void> => {
    try {
      const { outcome, count } = await processImage(filePath);
      if (outcome === "created") {
        filesWithVariants++;
        totalVariants += count;
      } else if (outcome === "failed") {
        totalErrors++;
      } else {
        totalSkipped++;
      }
    } catch (err) {
      totalErrors++;
      console.error(`  Error: ${filePath}`, err);
    } finally {
      completed++;
      // Log once per full concurrency "wave" instead of every 500 files
      if (completed % CONCURRENCY === 0 || completed === imagePaths.length) {
        console.log(
          `  +${completed}/${imagePaths.length} files (files: ${filesWithVariants}, variants: ${totalVariants}, skipped: ${totalSkipped}, errors: ${totalErrors})`,
        );
      }
    }
  };

  // Enqueue all paths (FIFO order). run() never rejects, so the queue's
  // internal promise stays resolved and onIdle() fires when everything is done.
  for (const filePath of imagePaths) {
    queue.add(() => run(filePath));
  }

  await queue.onIdle();

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const avgRate =
    totalTime > 0 ? Math.round(imagePaths.length / totalTime) : "?";
  console.log("");
  console.log("=== Backfill complete ===");
  console.log(`  Total time:          ${totalTime}s`);
  console.log(`  Average rate:        ${avgRate} files/s`);
  console.log(`  Files processed:     ${imagePaths.length}`);
  console.log(`  Files with variants: ${filesWithVariants}`);
  console.log(`  Variants created:    ${totalVariants}`);
  console.log(`  Skipped:             ${totalSkipped}`);
  console.log(`  Errors:              ${totalErrors}`);

  // Shut down worker threads so the process can exit cleanly.
  await pool.destroy();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
