const { put } = require('@vercel/blob');
const fs = require('fs');
require('dotenv').config({ path: '.env.local' });

async function upload() {
  console.log("Uploading DMG...");
  const file = fs.readFileSync("src-tauri/target/release/bundle/dmg/Vignan Exam Browser_0.1.0_aarch64.dmg");
  const blob = await put("lockdown/VignanExam.dmg", file, { access: 'public', token: process.env.BLOB_READ_WRITE_TOKEN, addRandomSuffix: false, allowOverwrite: true });
  console.log("Done!", blob.url);
}
upload().catch(console.error);
