import { Storage } from "@google-cloud/storage";
import PQueue from "p-queue";
import { Piscina } from "piscina";
import {
  SIZES,
  VARIANT_REGEX,
  lastSegment,
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

// Uses the VM's default service account (storage-rw scope) — no key file needed.
const storage = new Storage();
const sourceBucket = storage.bucket(SOURCE_BUCKET);
const variantsBucket = storage.bucket(VARIANTS_BUCKET);

/** Image extensions that count as a real with-extension upload. */
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|tiff?|avif)$/i;

/** A source-bucket original image (with-extension or extensionless). */
type Original = {
  path: string;
  updated?: string;
  generation?: string | number;
  contentType?: string | null;
};

/** A base with sibling collisions that needs cleanup + a variant rewrite. */
type AffectedBase = {
  base: string;
  keeper: Original;
  staleSiblings: string[];
  variantPaths: string[];
};

/**
 * Whether a source-bucket file is an original image we manage (with an image
 * extension, or extensionless legacy). Variants are always excluded.
 */
function isImageOriginalFile(name: string): boolean {
  if (!name || name.endsWith("/") || name.endsWith(":")) return false;
  if (VARIANT_REGEX.test(name)) return false;
  const filename = lastSegment(name);
  return IMAGE_EXT.test(filename) || !filename.includes(".");
}

function parseTime(updated?: string): number {
  return updated ? Date.parse(updated) : NaN;
}

function genNum(generation?: string | number): number | undefined {
  return generation !== undefined ? Number(generation) : undefined;
}

/** True when `a` is newer than `b` by (`updated`, `generation` tiebreak). */
function isNewerThan(
  a: { updated?: string; generation?: string | number },
  b: { updated?: string; generation?: string | number },
): boolean {
  const at = parseTime(a.updated);
  const bt = parseTime(b.updated);
  if (Number.isNaN(at)) return false; // unreadable → cannot be newer
  if (Number.isNaN(bt)) return true; // b unreadable, a readable → a is newer
  if (at !== bt) return at > bt;
  const ag = genNum(a.generation);
  const bg = genNum(b.generation);
  if (ag !== undefined && bg !== undefined) return ag > bg;
  return false;
}

/** True when `o` is provably older than the keeper (both timestamps readable). */
function isProvablyOlder(o: Original, keeper: Original): boolean {
  const ot = parseTime(o.updated);
  const kt = parseTime(keeper.updated);
  if (Number.isNaN(ot) || Number.isNaN(kt)) return false;
  if (ot < kt) return true;
  if (ot === kt) {
    const og = genNum(o.generation);
    const kg = genNum(keeper.generation);
    if (og !== undefined && kg !== undefined && og < kg) return true;
  }
  return false;
}

/**
 * Pick the LATEST eligible original as the surviving source for a base, or null
 * when no original has a readable timestamp (precision-first: never decide on
 * uncertain data). Mirrors the deployed trigger's cleanup rules.
 */
function pickKeeper(originals: Original[]): Original | null {
  let keeper: Original | null = null;
  for (const o of originals) {
    if (!isImageOriginalFile(o.path)) continue;
    if (o.contentType && !o.contentType.startsWith("image/")) continue;
    if (Number.isNaN(parseTime(o.updated))) continue; // must be readable
    if (!keeper || isNewerThan(o, keeper)) keeper = o;
  }
  return keeper;
}

async function main(): Promise<void> {
  console.log(`Reconciling sibling-collision bases in ${SOURCE_BUCKET}`);

  const startTime = Date.now();

  // Only the SOURCE bucket is needed: variants are always present and correctly
  // named. The only problem to fix is when a base has MORE THAN ONE original
  // (same base, different extension, or extensionless) — their shared variant
  // paths may have been written from the wrong (older) sibling. Only those
  // bases are touched: stale siblings are deleted and the 4 variants are
  // rewritten from the LATEST source.
  const [srcFiles] = await sourceBucket.getFiles();
  console.log(`Listed ${srcFiles.length} source object(s)`);

  // Group source originals by base name (before the extension).
  const originalsByBase = new Map<string, Original[]>();
  for (const f of srcFiles) {
    if (!isImageOriginalFile(f.name)) continue;
    const base = stripExtension(f.name);
    const arr = originalsByBase.get(base) ?? [];
    arr.push({
      path: f.name,
      updated: f.metadata?.updated,
      generation: f.metadata?.generation,
      contentType: f.metadata?.contentType ?? null,
    });
    originalsByBase.set(base, arr);
  }

  // Only bases with >1 original have sibling collisions.
  const affected: AffectedBase[] = [];
  let skipped = 0;
  for (const [base, originals] of originalsByBase) {
    if (originals.length < 2) continue; // no siblings — variants are fine

    const keeper = pickKeeper(originals);
    if (!keeper) {
      skipped++;
      console.log(
        `  SKIP ${base}: ${originals.length} sibling(s) but no readable timestamp — left untouched`,
      );
      continue;
    }

    const staleSiblings = originals
      .filter((o) => o !== keeper)
      .filter((o) => isImageOriginalFile(o.path))
      .filter((o) => !(o.contentType && !o.contentType.startsWith("image/")))
      .filter((o) => isProvablyOlder(o, keeper))
      .map((o) => o.path);

    const variantPaths = SIZES.map(
      (s) => `${base}_${s.suffix}${variantExt(keeper.path)}`,
    );

    affected.push({ base, keeper, staleSiblings, variantPaths });
  }

  // Report the plan.
  console.log(
    `\nBases with sibling collisions needing fixes: ${affected.length}`,
  );
  if (skipped > 0) {
    console.log(`Skipped (unreadable timestamps):             ${skipped}`);
  }
  for (const a of affected) {
    console.log(`\n  base: ${a.base}`);
    console.log(`    keeper: ${a.keeper.path}`);
    if (a.staleSiblings.length > 0) {
      console.log(`    delete: ${a.staleSiblings.join(", ")}`);
    }
    console.log(`    rewrite variants: ${a.variantPaths.join(", ")}`);
  }

  // ===== Apply =====
  const pool = new Piscina({
    filename: new URL("./backfill-worker.ts", import.meta.url).href,
    maxThreads: WORKERS,
  });

  if (affected.length > 0) {
    const queue = new PQueue({ concurrency: CONCURRENCY });
    let done = 0;
    let rewritten = 0;
    let errors = 0;

    const run = async (task: AffectedBase): Promise<void> => {
      try {
        const [buffer] = await sourceBucket.file(task.keeper.path).download();
        if (!buffer || buffer.length === 0) {
          console.error(`  Empty source for ${task.keeper.path}`);
          errors++;
          return;
        }
        // The keeper may have been deleted while we were downloading.
        const [stillExists] = await sourceBucket
          .file(task.keeper.path)
          .exists();
        if (!stillExists) {
          console.warn(`  Source gone for ${task.keeper.path}, skipping`);
          return;
        }
        const buffers = (await pool.run(buffer)) as Buffer[];
        if (buffers.length !== task.variantPaths.length) {
          console.error(
            `  Worker returned ${buffers.length} buffer(s) for ${task.base} (expected ${task.variantPaths.length})`,
          );
          errors++;
          return;
        }
        // Rewrite ALL variants for this base from the latest source.
        const uploads = await Promise.allSettled(
          task.variantPaths.map((path, i) =>
            variantsBucket
              .file(path)
              .save(buffers[i], {
                metadata: {
                  contentType: "image/webp",
                  cacheControl: "public, max-age=31536000",
                },
              })
              .then(() => path),
          ),
        );
        const ok = uploads.filter((r) => r.status === "fulfilled");
        const bad = uploads.filter((r) => r.status === "rejected");
        if (bad.length > 0 && ok.length > 0) {
          // Roll back the partial set so consumers never see a partial group.
          console.warn(
            `  Rolling back ${ok.length} variant(s) for ${task.base} after ${bad.length} failure(s)`,
          );
          await Promise.allSettled(
            ok.map((r) =>
              variantsBucket
                .file((r as PromiseFulfilledResult<string>).value)
                .delete(),
            ),
          );
          errors++;
          return;
        }
        rewritten += ok.length;
        console.log(
          `  + ${task.base}: ${ok.length} variant(s) from ${task.keeper.path}`,
        );
      } catch (err) {
        errors++;
        console.error(`  Error on ${task.base}:`, err);
      } finally {
        done++;
        if (done % CONCURRENCY === 0 || done === affected.length) {
          console.log(
            `  +${done}/${affected.length} bases (variants: ${rewritten}, errors: ${errors})`,
          );
        }
      }
    };

    for (const task of affected) queue.add(() => run(task));
    await queue.onIdle();

    // Delete stale siblings AFTER variants are correct, so the deployed
    // cleanupVariants trigger (which skips when the keeper exists) never
    // wipes the just-rewritten shared variant paths.
    const allStale = affected.flatMap((a) => a.staleSiblings);
    if (allStale.length > 0) {
      console.log(`\nDeleting ${allStale.length} stale same-base sibling(s)...`);
      const results = await Promise.allSettled(
        allStale.map((p) => sourceBucket.file(p).delete()),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      console.log(`  Deleted ${ok}/${allStale.length}`);
    }
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  console.log("\n=== Reconcile complete ===");
  console.log(`  Total time:        ${totalTime}s`);
  console.log(`  Bases rewritten:   ${affected.length}`);

  await pool.destroy();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
