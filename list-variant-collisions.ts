import { Storage } from "@google-cloud/storage";
import { lastSegment, stripExtension, VARIANT_REGEX } from "./src/variants.js";

const SOURCE_BUCKET =
  process.env.SOURCE_BUCKET ?? "prod-managesome.appspot.com";
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|tiff?|avif)$/i;

/**
 * READ-ONLY dry run — never deletes anything.
 *
 * Lists every original image in the source bucket, groups them by base name
 * (path before the extension) and prints every base that has MORE THAN ONE
 * original. Those are the same-base collisions the new cleanupStaleSiblings
 * trigger logic would resolve (deleting the provably-older sibling(s) when a
 * new with-extension file lands).
 *
 * Usage (from Backend/functions):
 *   SOURCE_BUCKET=prod-managesome.appspot.com npx tsx list-variant-collisions.ts
 */
function isOriginal(name: string): boolean {
  if (!name || name.endsWith("/")) return false;
  if (VARIANT_REGEX.test(name)) return false;
  const filename = lastSegment(name);
  return IMAGE_EXT.test(filename) || !filename.includes(".");
}

async function main(): Promise<void> {
  const storage = new Storage();
  const bucket = storage.bucket(SOURCE_BUCKET);
  console.log(`Listing ${SOURCE_BUCKET} (READ-ONLY — nothing is deleted)...`);

  const [allFiles] = await bucket.getFiles();
  const groups = new Map<string, typeof allFiles>();
  for (const file of allFiles) {
    if (!isOriginal(file.name)) continue;
    const base = stripExtension(file.name);
    const arr = groups.get(base) ?? [];
    arr.push(file);
    groups.set(base, arr);
  }

  let collisions = 0;
  for (const [base, files] of groups) {
    if (files.length < 2) continue;
    collisions++;
    console.log(`\n[${collisions}] BASE: ${base}`);
    for (const f of files.sort((a, b) =>
      (a.metadata?.updated ?? "").localeCompare(b.metadata?.updated ?? ""),
    )) {
      console.log(
        `    ${f.name}  updated=${f.metadata?.updated ?? "?"} gen=${f.metadata?.generation ?? "?"} type=${f.metadata?.contentType ?? "?"}`,
      );
    }
  }

  console.log(`\nTotal colliding basenames: ${collisions}`);
  if (collisions === 0) {
    console.log("No same-base collisions found — bucket is clean.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
