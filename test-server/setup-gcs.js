// setup-gcs.js - One-time GCS setup & verification.
//
//   node setup-gcs.js
//
// Tries to create the bucket (needs roles/storage.admin) and then verifies object-level access
// (write / signed-url / list / read / delete) which is all the running server actually needs.

require('dotenv').config();
const path = require('path');
const { Storage } = require('@google-cloud/storage');

const BUCKET = process.env.GCS_BUCKET_NAME || 'meet-cloud';
const LOCATION = process.env.GCS_LOCATION || 'ASIA-SOUTH1';
const KEY = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'Service-Account.json');

(async () => {
  const storage = new Storage({ keyFilename: KEY });
  const projectId = await storage.getProjectId();
  console.log(`Project: ${projectId}`);
  console.log(`Bucket : ${BUCKET}  (location ${LOCATION})\n`);

  const bucket = storage.bucket(BUCKET);

  // 1. Try to create the bucket (idempotent-ish). Bucket-level IAM required.
  try {
    await storage.createBucket(BUCKET, { location: LOCATION });
    console.log('✅ Bucket created.');
  } catch (e) {
    if (e.code === 409) console.log('ℹ️  Bucket already exists (ok).');
    else if (e.code === 403) console.log('⚠️  Cannot create bucket (no storage.buckets.create). Assuming it already exists.');
    else console.log('⚠️  createBucket:', e.message.split('\n')[0]);
  }

  // 2. Verify object-level access — this is what the server depends on.
  const probe = bucket.file(`meetings/_setupcheck/probe-${Date.now()}.txt`);
  try {
    await probe.save(Buffer.from('setup-check'), { contentType: 'text/plain', resumable: false });
    console.log('✅ Object write OK (resumable uploads will work).');

    const [url] = await probe.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 3600000 });
    console.log('✅ V4 signed URL OK.');

    const [files] = await bucket.getFiles({ prefix: 'meetings/' });
    console.log(`✅ List OK (${files.length} object(s) under meetings/).`);

    const [buf] = await probe.download();
    console.log('✅ Download OK:', buf.toString());

    await probe.delete({ ignoreNotFound: true });
    console.log('✅ Delete OK (cleaned up probe).\n');
    console.log('🎉 GCS is ready. Start the server with STORAGE_BACKEND=gcs.');
  } catch (e) {
    console.error('❌ Object access failed:', e.message.split('\n')[0]);
    console.error('   Grant the service account roles/storage.objectAdmin on the bucket.');
    process.exit(1);
  }
})();
