/**
 * Cloudinary Upload Verification Script
 *
 * Tests that Cloudinary credentials work by uploading the test video
 * directly using the Cloudinary Node.js SDK.
 *
 * Run with: npx tsx scratch/upload_test.ts
 */

import { v2 as cloudinary } from "cloudinary";
import * as path from "path";

const CLOUD_NAME = "dxegxiteh";
const API_KEY = "612494837862384";
const API_SECRET = "X2uWRBiz4m6vfr398hpf8Uowho8";

cloudinary.config({
  cloud_name: CLOUD_NAME,
  api_key: API_KEY,
  api_secret: API_SECRET,
  secure: true,
});

async function main() {
  const videoPath = path.resolve(__dirname, "../public/videos/forex vid.mp4");

  console.log("Cloudinary Upload Verification");
  console.log("─".repeat(40));
  console.log(`Cloud name: ${CLOUD_NAME}`);
  console.log(`Video path: ${videoPath}`);
  console.log();

  console.log("Uploading to Cloudinary...");
  const result = await cloudinary.uploader.upload(videoPath, {
    resource_type: "video",
    folder: "reelcast-test",
    public_id: `test-${Date.now()}`,
  });

  console.log("Upload successful!");
  console.log("─".repeat(40));
  console.log(`  URL:        ${result.secure_url}`);
  console.log(`  Public ID:  ${result.public_id}`);
  console.log(`  Bytes:      ${result.bytes}`);
  console.log(`  Duration:   ${result.duration}s`);
  console.log(`  Format:     ${result.format}`);
  console.log(`  Created at: ${result.created_at}`);
  console.log();
  console.log("Credentials verified. Cleaning up test upload...");

  await cloudinary.uploader.destroy(result.public_id, {
    resource_type: "video",
  });

  console.log("Test upload deleted. All good!");
}

main().catch((err) => {
  console.error("Upload verification FAILED:");
  console.error(err);
  process.exit(1);
});
