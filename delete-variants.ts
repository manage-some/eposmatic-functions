import { Storage } from "@google-cloud/storage";

const VARIANTS_BUCKET = "prod-managesome-variants";

const storage = new Storage();
const variantsBucket = storage.bucket(VARIANTS_BUCKET);

async function main(): Promise<void> {
  console.log(`Deleting all objects in ${VARIANTS_BUCKET}...`);

  // Collect all file names via getFilesStream
  const files: string[] = [];
  const stream = variantsBucket.getFilesStream();
  for await (const file of stream) {
    files.push(file.name);
  }

  console.log(`  Found ${files.length} objects`);

  // Delete in batches of 1000 to keep memory bounded
  const BATCH = 1000;
  let deleted = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (name) => {
        await variantsBucket.file(name).delete();
        deleted++;
        if (deleted % 5000 === 0) {
          console.log(`  Deleted ${deleted}...`);
        }
      }),
    );
  }

  console.log("");
  console.log("=== Done ===");
  console.log(`  Total deleted: ${deleted}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
