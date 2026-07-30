import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const PROJECT = "dev-managesome";
const SOURCE_BUCKET = "dev-managesome.appspot.com";
const VARIANTS_BUCKET = "dev-managesome-variants";
const CONCURRENCY = 30;
const TMP = join(tmpdir(), "backfill-variants");
mkdirSync(TMP, { recursive: true });

const SIZES = [
  { suffix: "64x64", width: 64, height: 64 },
  { suffix: "128x128", width: 128, height: 128 },
  { suffix: "256x256", width: 256, height: 256 },
  { suffix: "512x512", width: 512, height: 512 },
] as const;

const VARIANT_REGEX = /_\d+x\d+(\.webp)?$/i;

function gcloudStorage(args: string[]): void {
  execFileSync("gcloud", ["storage", ...args, "--project", PROJECT], {
    stdio: "ignore",
    timeout: 30_000,
  });
}

async function processImage(gcsPath: string): Promise<number> {
  const filePath = gcsPath.replace(`gs://${SOURCE_BUCKET}/`, "");
  const basePath = filePath.replace(/\.[^.]+$/, "");

  // Single temp dir per image
  const imgDir = join(TMP, Buffer.from(gcsPath).toString("base64"));
  mkdirSync(imgDir, { recursive: true });
  const localFile = join(imgDir, "original");

  // 1 gcloud call — download
  gcloudStorage(["cp", gcsPath, localFile]);

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
      gcloudStorage(["cp", tmpFile, `gs://${VARIANTS_BUCKET}/${variantPath}`]);
    }),
  );

  const created = results.filter((r) => r.status === "fulfilled").length;
  rmSync(imgDir, { recursive: true, force: true });
  return created;
}

async function main() {
  console.log(
    `Backfilling variants from ${SOURCE_BUCKET} → ${VARIANTS_BUCKET}`,
  );
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log("");

  const listResult = execFileSync(
    "gcloud",
    [
      "storage",
      "ls",
      "--recursive",
      `gs://${SOURCE_BUCKET}/images/`,
      "--project",
      PROJECT,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  ).trim();

  const allFiles = listResult
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const name = line.trim().replace(`gs://${SOURCE_BUCKET}/`, "");
      if (!name) return false;
      if (VARIANT_REGEX.test(name)) return false;
      // Include image extensions OR files with no extension at all
      // (warehouse doesn't append extensions)
      const hasImageExt = /\.(jpg|jpeg|png|webp|bmp|tiff|tif|avif)$/i.test(name);
      const hasNoExt = !name.includes(".");
      if (!hasImageExt && !hasNoExt) return false;
      return true;
    });

  console.log(`Total images to process: ${allFiles.length}`);
  console.log("");

  let processed = 0;
  let errors = 0;
  let batchNum = 0;

  for (let i = 0; i < allFiles.length; i += CONCURRENCY) {
    batchNum++;
    const batch = allFiles.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (gcsPath) => {
        try {
          return (await processImage(gcsPath)) > 0 ? "created" : "empty";
        } catch (err) {
          console.error(`  Error: ${gcsPath}`, err);
          return "error";
        }
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value === "created") processed++;
        else if (r.value === "error") errors++;
      } else {
        errors++;
      }
    }

    const done = Math.min(i + CONCURRENCY, allFiles.length);
    const pct = Math.round((done / allFiles.length) * 100);
    console.log(
      `Batch ${batchNum}: ${done}/${allFiles.length} (${pct}%) — created: ${processed}, errors: ${errors}`,
    );
  }

  console.log("");
  console.log("=== Backfill complete ===");
  console.log(`  Variants created for: ${processed} images`);
  console.log(`  Errors:                ${errors}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
