// Verify fresh packages without launching/installing the kiosk, then stage stable names.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const targets = {
  windows: { host: 'win32', triple: 'x86_64-pc-windows-msvc', files: [['nsis', '.exe', 'VignanExam_setup.exe'], ['msi', '.msi', 'VignanExam.msi']] },
  linux: { host: 'linux', triple: 'x86_64-unknown-linux-gnu', files: [['appimage', '.AppImage', 'VignanExam.AppImage'], ['deb', '.deb', 'VignanExam.deb']] },
  macos: { host: 'darwin', triple: 'aarch64-apple-darwin', files: [['dmg', '.dmg', 'VignanExam.dmg']] },
};

export function verifyHeader(bytes, extension, x64 = false) {
  if (extension === '.exe') {
    assert.equal(bytes.subarray(0, 2).toString(), 'MZ', 'Missing DOS header');
    const offset = bytes.readUInt32LE(60);
    assert(offset >= 64 && offset + 24 <= bytes.length, 'Invalid PE offset');
    assert.equal(bytes.subarray(offset, offset + 4).toString(), 'PE\0\0', 'Missing PE header');
    if (x64) assert.equal(bytes.readUInt16LE(offset + 4), 0x8664, 'Expected x64 PE');
  } else if (extension === '.AppImage' || extension === '.elf') {
    assert.equal(bytes.subarray(0, 4).toString(), '\x7fELF', 'Missing ELF header');
    assert.equal(bytes[4], 2, 'Expected ELF64');
    assert.equal(bytes[5], 1, 'Expected little endian ELF');
    assert.equal(bytes[6], 1, 'Invalid ELF version');
    assert.equal(bytes.readUInt16LE(18), 62, 'Expected x86-64 ELF');
    if (extension === '.AppImage') assert.deepEqual(bytes.subarray(8, 11), Buffer.from([0x41, 0x49, 2]), 'Expected type-2 AppImage');
  } else if (extension === '.msi') {
    assert.equal(bytes.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1', 'Missing MSI compound-file header');
  } else if (extension === '.deb') {
    assert.equal(bytes.subarray(0, 8).toString(), '!<arch>\n', 'Missing Debian archive header');
  }
}

export function verifyDesktopEntry(text) {
  const section = text.split(/^\[Desktop Entry\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
  assert(/^Type=Application\r?$/m.test(section), 'Missing desktop application type');
  const mime = section.match(/^MimeType=(.*)$/m)?.[1].trim().split(';') ?? [];
  assert(mime.includes('x-scheme-handler/vignan-exam'), 'Missing vignan-exam desktop MIME handler');
  const command = section.match(/^Exec=(.*)$/m)?.[1] ?? '';
  assert(/(?:^|[ /"'])vignan-lockdown(?:["']?\s|$)/.test(command) && /%[uU](?:\s|$)/.test(command), 'Desktop Exec must pass URLs to vignan-lockdown');
}

export function verifyNsisRecipe(text) {
  assert(/^!define INSTALLMODE "currentUser"\r?$/m.test(text), 'NSIS must install per user');
  assert(/^!define MAINBINARYNAME "vignan-lockdown"\r?$/m.test(text), 'Unexpected NSIS binary');
  const lines = text.split(/\r?\n/).map(line => line.trim());
  assert(lines.some(line => /^WriteRegStr SHCTX "Software\\Classes\\+vignan-exam" "URL Protocol" ""$/.test(line)), 'NSIS URL Protocol registration missing');
  assert(lines.some(line => /^WriteRegStr SHCTX "Software\\Classes\\+vignan-exam\\shell\\open\\command" "" /.test(line) &&
    line.endsWith('"$\\"$INSTDIR\\${MAINBINARYNAME}.exe$\\" $\\"%1$\\""')), 'NSIS URL command must quote the executable and URL');
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
}
async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(file));
    else files.push(file);
  }
  return files;
}
async function one(directory, extension) {
  const matches = (await readdir(directory)).filter(name => name.endsWith(extension));
  assert.equal(matches.length, 1, `Expected exactly one ${extension} in ${directory}, found ${matches.length}`);
  return path.join(directory, matches[0]);
}
async function header(file, extension, x64 = false) {
  const handle = await open(file);
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, 0);
    verifyHeader(buffer.subarray(0, bytesRead), extension, x64);
  } finally { await handle.close(); }
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function desktopFiles(directory) {
  const files = (await filesBelow(directory)).filter(file => file.endsWith('.desktop'));
  const matching = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (text.includes('x-scheme-handler/vignan-exam')) {
      verifyDesktopEntry(text);
      run('desktop-file-validate', [file]);
      matching.push(file);
    }
  }
  assert(matching.length > 0, 'Package contains no vignan-exam desktop handler');
}

export async function stageInstallers(platform, root = process.cwd()) {
  const target = targets[platform];
  assert(target, 'Usage: node scripts/lockdown/stage-installers.mjs windows|linux|macos');
  assert.equal(process.platform, target.host, `Verify ${platform} packages on their native runner`);
  const release = path.join(root, 'src-tauri/target', target.triple, 'release');
  const output = path.join(root, 'src-tauri/target/installers', platform);
  // Fail instead of mixing this run with pre-existing staged artifacts.
  await mkdir(output, { recursive: false });
  const temporary = await mkdtemp(path.join(tmpdir(), 'vignan-package-check-'));
  const artifacts = [];
  try {
    for (const [bundle, extension, name] of target.files) {
      const source = await one(path.join(release, 'bundle', bundle), extension);
      const size = (await stat(source)).size;
      assert(size > 1024 * 1024, `${name} is implausibly small; refusing placeholder/corrupt package`);
      if (extension !== '.dmg') await header(source, extension);
      const checks = ['package-size', ...(extension === '.dmg' ? [] : ['package-header'])];
      if (extension === '.exe') {
        const recipe = await one(path.join(release, 'nsis/x64'), '.nsi');
        verifyNsisRecipe(await readFile(recipe, 'utf8'));
        const unpacked = path.join(temporary, 'nsis');
        run('7z', ['x', '-y', `-o${unpacked}`, source]);
        const executables = (await filesBelow(unpacked)).filter(file => path.basename(file) === 'vignan-lockdown.exe');
        assert.equal(executables.length, 1, 'NSIS must contain the main application');
        await header(executables[0], '.exe', true);
        assert.equal(await sha256(executables[0]), await sha256(path.join(release, 'vignan-lockdown.exe')), 'NSIS payload differs from this build');
        checks.push('nsis-recipe-protocol', 'extracted-x64-payload-sha256');
      } else if (extension === '.msi') {
        const result = JSON.parse(run('pwsh', ['-NoProfile', '-File', path.join(root, 'scripts/lockdown/verify-msi.ps1'), '-Path', source]));
        assert.equal(result.protocol, 'vignan-exam');
        checks.push('msi-database-x64-product-file-and-protocol');
      } else if (extension === '.deb') {
        assert.equal(run('dpkg-deb', ['--field', source, 'Architecture']).trim(), 'amd64');
        const depends = run('dpkg-deb', ['--field', source, 'Depends']);
        for (const dependency of ['libwebkit2gtk-4.1-0', 'xdg-utils', 'desktop-file-utils']) {
          assert(depends.includes(dependency), `Debian dependency missing: ${dependency}`);
        }
        const unpacked = path.join(temporary, 'deb');
        run('dpkg-deb', ['--extract', source, unpacked]);
        await header(path.join(unpacked, 'usr/bin/vignan-lockdown'), '.elf');
        await desktopFiles(path.join(unpacked, 'usr/share/applications'));
        checks.push('deb-amd64-dependencies', 'extracted-elf-and-desktop-protocol');
      } else if (extension === '.AppImage') {
        await chmod(source, 0o755);
        // Only the AppImage runtime's extraction mode executes, never AppRun/the kiosk.
        const extractionEnv = { ...process.env };
        delete extractionEnv.APPIMAGE_EXTRACT_AND_RUN;
        run(source, ['--appimage-extract'], { cwd: temporary, env: extractionEnv });
        const unpacked = path.join(temporary, 'squashfs-root');
        await header(path.join(unpacked, 'usr/bin/vignan-lockdown'), '.elf');
        await desktopFiles(unpacked);
        checks.push('appimage-extraction', 'extracted-elf-and-desktop-protocol');
      } else if (extension === '.dmg') {
        run('hdiutil', ['verify', source]);
        const app = await one(path.join(release, 'bundle/macos'), '.app');
        run('codesign', ['--verify', '--deep', '--strict', app]);
        const plist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')]));
        assert(plist.CFBundleURLTypes?.some(type => type.CFBundleURLSchemes?.includes('vignan-exam')), 'macOS bundle protocol missing');
        checks.push('hdiutil-verify', 'built-app-adhoc-signature-integrity', 'built-app-plist-protocol');
      }
      await copyFile(source, path.join(output, name));
      if (extension === '.AppImage') await chmod(path.join(output, name), 0o755);
      artifacts.push({ file: name, bytes: size, sha256: await sha256(source), checks });
    }
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
    if (process.env.GITHUB_SHA) assert.equal(commit, process.env.GITHUB_SHA, 'Build checkout does not match run SHA');
    const manifest = { commit, target: target.triple, protocol: 'vignan-exam', runId: process.env.GITHUB_RUN_ID ?? null,
      installedOrLaunched: false, signingVerified: false, artifacts };
    await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(output, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${item.file}\n`).join(''));
    console.log(`Verified/staged ${artifacts.map(item => item.file).join(', ')} in ${path.relative(root, output)}. No kiosk launched; installed OS behavior/signing not verified.`);
    return manifest;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The platform-specific leaf must not already exist, but its parent may.
  await mkdir(path.resolve('src-tauri/target/installers'), { recursive: true });
  await stageInstallers(process.argv[2]);
}
