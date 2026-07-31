import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

const PROJECT = "prod-managesome";
const SOURCE_BUCKET = "prod-managesome.appspot.com";
const VARIANTS_BUCKET = "prod-managesome-variants";
const CONCURRENCY = 150;
const TMP = join(tmpdir(), "backfill-variants");
mkdirSync(TMP, { recursive: true });

const SIZES = [
  { suffix: "64x64", width: 64, height: 64 },
  { suffix: "128x128", width: 128, height: 128 },
  { suffix: "256x256", width: 256, height: 256 },
  { suffix: "512x512", width: 512, height: 512 },
] as const;

const VARIANT_REGEX = /_\d+x\d+(\.webp)?$/i;

async function gcloudStorageAsync(args: string[]): Promise<void> {
  await execFileAsync("gcloud", ["storage", ...args, "--project", PROJECT], {
    timeout: 120_000,
  });
}

async function processImage(gcsPath: string): Promise<number> {
  // Guard: skip anything that looks like a directory or listing entry
  if (gcsPath.endsWith("/") || gcsPath.endsWith(":")) return 0;

  const filePath = gcsPath.replace(`gs://${SOURCE_BUCKET}/`, "");
  const basePath = filePath.replace(/\.[^.]+$/, "");

  // Single temp dir per image
  const imgDir = join(TMP, Buffer.from(gcsPath).toString("base64"));
  mkdirSync(imgDir, { recursive: true });
  const localFile = join(imgDir, "original");

  // 1 gcloud call — download
  await gcloudStorageAsync(["cp", gcsPath, localFile]);

  const buffer = readFileSync(localFile);
  if (!buffer || buffer.length === 0) {
    rmSync(imgDir, { recursive: true, force: true });
    return 0;
  }

  // Generate and upload all 4 variants in parallel
  const results = await Promise.allSettled(
    SIZES.map(async (size) => {
      // Only append .webp if the original had an extension
      const variantExt = filePath.includes(".") ? ".webp" : "";
      const variantPath = `${basePath}_${size.suffix}${variantExt}`;
      const tmpFile = join(imgDir, size.suffix);

      const resizedBuffer = await sharp(buffer, {
        limitInputPixels: 100_000_000,
      })
        .resize(size.width, size.height, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer();

      writeFileSync(tmpFile, resizedBuffer);
      await gcloudStorageAsync([
        "cp",
        tmpFile,
        `gs://${VARIANTS_BUCKET}/${variantPath}`,
      ]);
    }),
  );

  const created = results.filter((r) => r.status === "fulfilled").length;
  rmSync(imgDir, { recursive: true, force: true });
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

function listDir(prefix: string): { dirs: string[]; files: string[] } {
  const result = execFileSync(
    "gcloud",
    ["storage", "ls", `gs://${SOURCE_BUCKET}/${prefix}`, "--project", PROJECT],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
  ).trim();

  const dirs: string[] = [];
  const files: string[] = [];

  for (const line of result.split("\n").filter(Boolean)) {
    const path = line.trim();
    const name = path
      .replace(`gs://${SOURCE_BUCKET}/`, "")
      .replace(/:$/, "");
    if (!name) continue;
    // Skip the current directory itself (gcloud may return it in listing)
    if (name.replace(/\/$/, "") === prefix.replace(/\/$/, "")) {
      continue;
    }
    if (name.endsWith("/")) {
      dirs.push(name);
    } else if (isImageFile(name)) {
      files.push(path);
    }
  }

  return { dirs, files };
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

async function walkTree(prefix: string): Promise<void> {
  const { dirs, files } = listDir(prefix);

  // Process files in this directory in batches
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const { created, skipped, errors } = await processBatch(batch);
    processed += created;
    totalSkipped += skipped;
    totalErrors += errors;
    totalFiles += batch.length;

    console.log(
      `  ${prefix}: +${batch.length} files (created: ${processed}, errors: ${totalErrors})`,
    );
  }

  // Recurse into subdirectories
  for (const dir of dirs) {
    await walkTree(dir);
  }
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
  await walkTree("images/");

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
