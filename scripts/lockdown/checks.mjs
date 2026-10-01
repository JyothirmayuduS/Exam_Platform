// Unit fixtures test the verifier itself; none are emitted as installer artifacts.
// Deliberately not named *.test.mjs so Vitest does not collect Node's test suite.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEnvironment } from './validate-env.mjs';
import { verifyDesktopEntry, verifyHeader, verifyNsisRecipe } from './stage-installers.mjs';

const valid = {
  VITE_SUPABASE_URL: 'https://release-test.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_unit_test_not_a_real_api_key',
  VITE_LIVEKIT_URL: 'wss://release-test.livekit.cloud',
  VITE_APP_BASE_URL: 'https://exam.test',
  VITE_EXAM_ENTRY_PATH: '/student/exam',
  VITE_PROCTOR_CAPTURE: 'true',
  VITE_ALLOW_ANON_ROLL: 'false',
};
function jwt(role, extras = {}) {
  return ['unit-test', Buffer.from(JSON.stringify({ role, exp: 4102444800, ref: 'release-test', ...extras })).toString('base64url'), 'not-a-signature'].join('.');
}

test('accepts public-client configuration and legacy anon JWT shape only', () => {
  assert.deepEqual(validateEnvironment(valid), []);
  assert.deepEqual(validateEnvironment({ ...valid, VITE_SUPABASE_ANON_KEY: jwt('anon') }), []);
});
test('rejects missing backend, LiveKit and public web origin configuration', () => {
  const errors = validateEnvironment({});
  for (const name of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_LIVEKIT_URL', 'VITE_APP_BASE_URL']) {
    assert(errors.some(error => error.startsWith(name)));
  }
});
test('rejects secret/service-role, expired, wrong-project and malformed keys without logging values', () => {
  for (const key of ['sb_secret_unit_test_do_not_ship', jwt('service_role'), jwt('authenticated'), jwt('anon', { exp: 1 }), jwt('anon', { ref: 'other-project' }), 'your-anon-public-key']) {
    const errors = validateEnvironment({ ...valid, VITE_SUPABASE_ANON_KEY: key });
    assert(errors.some(error => error.startsWith('VITE_SUPABASE_ANON_KEY')));
    assert(!errors.join('\n').includes(key));
  }
});
test('rejects placeholders, unsafe protocols and credential-bearing URLs', () => {
  for (const [name, value] of [
    ['VITE_SUPABASE_URL', 'https://YOUR-PROJECT-ref.supabase.co'],
    ['VITE_SUPABASE_URL', 'http://localhost:54321'],
    ['VITE_LIVEKIT_URL', 'wss://your-project.livekit.cloud'],
    ['VITE_LIVEKIT_URL', 'https://release-test.livekit.cloud'],
    ['VITE_APP_BASE_URL', 'https://user:password@exam.test'],
    ['VITE_LOCKDOWN_DOWNLOAD_WIN', 'https://downloads.vignan.exam/lockdown/VignanExam_setup.exe'],
  ]) assert(validateEnvironment({ ...valid, [name]: value }).some(error => error.startsWith(name)));
});
test('release safety flags cannot silently enable demo authentication or disable capture', () => {
  for (const [name, value] of [['VITE_ALLOW_ANON_ROLL', 'true'], ['VITE_PROCTOR_CAPTURE', 'false'], ['VITE_EXAM_ENTRY_PATH', '/']]) {
    assert(validateEnvironment({ ...valid, [name]: value }).some(error => error.startsWith(name)));
  }
});
test('validates PE structure, not just MZ placeholder bytes', () => {
  assert.throws(() => verifyHeader(Buffer.from('MZ'), '.exe'));
  const pe = Buffer.alloc(128);
  pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68);
  verifyHeader(pe, '.exe', true);
  pe.writeUInt16LE(0x14c, 68);
  assert.throws(() => verifyHeader(pe, '.exe', true), /x64/);
  pe.writeUInt32LE(10000, 60);
  assert.throws(() => verifyHeader(pe, '.exe'), /offset/);
});
test('validates type-2 x64 AppImage header, not arbitrary ELF or a placeholder', () => {
  const elf = Buffer.alloc(64);
  elf.write('\x7fELF'); elf[4] = 2; elf[5] = 1; elf[6] = 1; elf.writeUInt16LE(62, 18);
  assert.throws(() => verifyHeader(elf, '.AppImage'), /type-2/);
  Buffer.from([0x41, 0x49, 2]).copy(elf, 8);
  verifyHeader(elf, '.AppImage');
  elf.writeUInt16LE(183, 18);
  assert.throws(() => verifyHeader(elf, '.AppImage'), /x86-64/);
});
test('checks MSI and Debian magic and rejects HTML fallback pages', () => {
  verifyHeader(Buffer.from('d0cf11e0a1b11ae1', 'hex'), '.msi');
  verifyHeader(Buffer.from('!<arch>\n'), '.deb');
  for (const extension of ['.exe', '.AppImage', '.msi', '.deb']) {
    assert.throws(() => verifyHeader(Buffer.from('<html>not an installer</html>'), extension));
  }
});
const desktop = '[Desktop Entry]\nType=Application\nExec=vignan-lockdown %U\nMimeType=x-scheme-handler/vignan-exam;\n';
test('requires desktop protocol registration and URL forwarding in the real entry section', () => {
  verifyDesktopEntry(desktop);
  for (const invalid of [desktop.replace(' %U', ''), desktop.replace('vignan-exam', 'other'), desktop.replace('Exec=vignan-lockdown', 'Exec=other'), desktop.replace('[Desktop Entry]', '[Desktop Action Other]')]) {
    assert.throws(() => verifyDesktopEntry(invalid));
  }
});
test('Linux overlay uses the URL-forwarding desktop template for both deb and AppImage', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(readFileSync(path.join(directory, 'tauri-linux.json'), 'utf8'));
  assert.equal(config.bundle.linux.appimage.bundleMediaFramework, true);
  assert(config.bundle.linux.deb.depends.includes('xdg-utils'));
  assert(config.bundle.linux.deb.depends.includes('desktop-file-utils'));
  const template = path.resolve(directory, '../../src-tauri', config.bundle.linux.deb.desktopTemplate);
  verifyDesktopEntry(readFileSync(template, 'utf8').replaceAll('{{exec}}', 'vignan-lockdown'));
});
const nsis = String.raw`!define INSTALLMODE "currentUser"
!define MAINBINARYNAME "vignan-lockdown"
WriteRegStr SHCTX "Software\Classes\\vignan-exam" "URL Protocol" ""
WriteRegStr SHCTX "Software\Classes\\vignan-exam\shell\open\command" "" "$\"$INSTDIR\@MAINBINARY@.exe$\" $\"%1$\""
`.replace('@MAINBINARY@', '${MAINBINARYNAME}');
test('requires generated NSIS per-user protocol recipe with quoted executable and URL', () => {
  verifyNsisRecipe(nsis);
  for (const invalid of [nsis.replace('currentUser', 'perMachine'), nsis.replace('URL Protocol', 'Other'), nsis.replace('%1', ''), nsis.replaceAll('vignan-exam', 'other')]) {
    assert.throws(() => verifyNsisRecipe(invalid));
  }
});
