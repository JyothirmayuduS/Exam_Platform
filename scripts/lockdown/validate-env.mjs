// CI preflight only: never loads .env files or prints configuration values.
import { pathToFileURL } from 'node:url';

export function validateEnvironment(env) {
  const errors = [];
  const placeholder = /YOUR[-_]|PASTE[-_]|your-anon-public-key|example\.(com|org|net)|downloads\.vignan\.exam/i;
  function url(name, protocol, optional = false) {
    const value = env[name] ?? '';
    if (optional && !value) return;
    try {
      const parsed = new URL(value);
      if (value !== value.trim() || placeholder.test(value) || parsed.protocol !== protocol ||
          parsed.username || parsed.password || !parsed.hostname.includes('.') ||
          /^(localhost|127\.|0\.)/.test(parsed.hostname)) throw new Error();
    } catch {
      errors.push(`${name} must be a non-placeholder ${protocol}// URL without credentials`);
    }
  }
  url('VITE_SUPABASE_URL', 'https:');
  url('VITE_LIVEKIT_URL', 'wss:');
  url('VITE_APP_BASE_URL', 'https:');
  for (const suffix of ['URL', 'WIN', 'MAC', 'LINUX']) {
    url(`VITE_LOCKDOWN_DOWNLOAD_${suffix}`, 'https:', true);
  }
  const key = env.VITE_SUPABASE_ANON_KEY ?? '';
  let publicKey = /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key);
  if (!publicKey) {
    try {
      const parts = key.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      const project = new URL(env.VITE_SUPABASE_URL).hostname.match(/^([^.]+)\.supabase\.co$/)?.[1];
      publicKey = parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)) &&
        payload.role === 'anon' && Number.isFinite(payload.exp) && payload.exp * 1000 > Date.now() &&
        (!project || payload.ref === project);
    } catch { /* The failure below contains no key material. */ }
  }
  if (!publicKey || placeholder.test(key)) {
    errors.push('VITE_SUPABASE_ANON_KEY must be a publishable key or unexpired legacy anon JWT for this project; never a secret/service_role key');
  }
  if (env.VITE_EXAM_ENTRY_PATH !== '/student/exam') {
    errors.push('VITE_EXAM_ENTRY_PATH must be /student/exam for installer builds');
  }
  if (env.VITE_PROCTOR_CAPTURE !== 'true') {
    errors.push('VITE_PROCTOR_CAPTURE must be true for proctored installer builds');
  }
  if (env.VITE_ALLOW_ANON_ROLL !== 'false') {
    errors.push('VITE_ALLOW_ANON_ROLL must be false for installer builds');
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = validateEnvironment(process.env);
  if (errors.length) {
    console.error(`Installer frontend configuration is invalid:\n- ${errors.join('\n- ')}\nSet repository Actions secrets or variables before building. Values were not logged.`);
    process.exitCode = 1;
  } else {
    console.log('Installer frontend configuration shape validated (backend connectivity/authentication still require smoke tests).');
  }
}
