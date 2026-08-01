import sharp from "sharp";
import {
  LARGE_VARIANT_WIDTH,
  SIZES,
  encodeVariant,
  webpEncodeOptions,
} from "./src/variants.js";

// One worker thread per vCPU, each running a single encode at a time — so the
// total libvips thread count stays pinned to the CPU count (no oversubscription
// like the single-process shared pool had under high concurrency).
sharp.concurrency(1);

/**
 * Worker task (invoked by piscina): decode + encode all 4 variants for a
 * source image on a dedicated worker thread, keeping the main thread free for
 * GCS I/O. Returns the variant buffers in SIZES order (64,128,256,512).
 */
export default async function encodeVariants(
  buffer: Buffer,
): Promise<Buffer[]> {
  const { format } = await sharp(buffer, {
    limitInputPixels: 100_000_000,
  }).metadata();

  const variants: Buffer[] = [];
  for (const size of SIZES) {
    // Preserve source quality; only the largest variant gets a lossy
    // q85 fallback (keeps whichever is smaller) as a safety net.
    const { buffer: encoded } = await encodeVariant(
      buffer,
      size,
      webpEncodeOptions(format),
      size.width >= LARGE_VARIANT_WIDTH,
    );
    variants.push(encoded);
  }
  return variants;
}
