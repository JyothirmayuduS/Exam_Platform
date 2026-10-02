// Upload staged installer files to the Vercel Blob store that vercel.json's
// /downloads/* redirects point at. Binaries never enter git — CI builds them
// (tag lockdown-v*), you download the run artifacts, this script publishes them.
//
// Requires:
//   BLOB_READ_WRITE_TOKEN  from .env.local (or the Vercel project env)
//   @vercel/blob           npm install --no-save @vercel/blob
//
// Usage:
//   node scripts/lockdown/upload-blob.mjs <artifact-dir-or-file>...
// Every VignanExam* file found (recursively) is uploaded to
// lockdown/<basename> — the exact pathnames vercel.json redirects expect —
// overwriting the previous version. SHA256SUMS files sitting next to the
// installers are verified BEFORE anything is uploaded.

const STORE_PREFIX = "lockdown/";

const MIME = {
  ".exe": "application/vnd.microsoft.portable-executable",
  ".msi": "application/x-msdownload",
  ".deb": "application/vnd.debian.binary-package",
  ".dmg": "application/x-apple-diskimage",
  ".AppImage": "application/octet-stream",
};

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("Usage: node scripts/lockdown/upload-blob.mjs <artifact-dir-or-file>...");
    process.exit(1);
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN is not set. Source .env.local first, e.g.:");
    console.error('  export $(grep -E "^BLOB_READ_WRITE_TOKEN=" .env.local | xargs)');
    process.exit(1);
  }

  let put;
  try {
    ({ put } = await import("@vercel/blob"));
  } catch {
    console.error("@vercel/blob is not installed. Run: npm install --no-save @vercel/blob");
    process.exit(1);
  }

  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { basename, isAbsolute, resolve } = await import("node:path");
  const { createHash } = await import("node:crypto");

  // Expand targets into installer files, verifying any SHA256SUMS found.
  const files = [];
  const walk = (entry) => {
    const path = isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (!name.startsWith(".")) walk(`${path}/${name}`);
      }
      return;
    }
    files.push(path);
  };
  for (const t of targets) walk(t);

  // Verify every sibling SHA256SUMS before uploading anything.
  for (const sums of files.filter((f) => basename(f) === "SHA256SUMS")) {
    const dir = sums.slice(0, sums.lastIndexOf("/"));
    for (const line of readFileSync(sums, "utf8").split("\n").filter((l) => l.trim())) {
      const [hash, name] = line.trim().split(/\s+/, 2);
      const file = `${dir}/${name.replace(/^\*/, "")}`;
      const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (actual !== hash) {
        console.error(`CHECKSUM MISMATCH: ${file} (${actual} != ${hash}) — aborting, nothing uploaded.`);
        process.exit(1);
      }
    }
    console.log(`checksums OK: ${sums}`);
  }

  const installers = files.filter((f) => /VignanExam[_\-.](setup\.exe|msi|dmg|AppImage|deb)$/.test(f));
  if (installers.length === 0) {
    console.error("No VignanExam_* installer files found in the given targets.");
    process.exit(1);
  }

  for (const file of installers.sort()) {
    const name = basename(file);
    const pathname = `${STORE_PREFIX}${name}`;
    const body = readFileSync(file);
    const result = await put(pathname, body, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: MIME[extname2(name)] ?? "application/octet-stream",
    });
    console.log(`uploaded ${pathname}  ${(body.length / 1048576).toFixed(1)} MiB  ->  ${result.url}`);
  }
  console.log("done — vercel.json's /downloads/* redirects now serve these files.");
}

function extname2(name) {
  // .AppImage has two dots; pick the suffix that our MIME table knows.
  if (name.endsWith(".AppImage")) return ".AppImage";
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
