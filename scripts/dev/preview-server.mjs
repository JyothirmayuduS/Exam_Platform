// Zero-native-dependency dev server for exam-platform.
// Uses sucrase (on-the-fly TS/JSX transpile) + tailwindcss CLI (already in devDeps).
// Run:  node preview-server.mjs   ->  http://127.0.0.1:5174
// This exists as a fallback for environments where the rolldown-vite native
// binding is unavailable. On a normal machine, prefer `npm run dev`.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { transform } from 'sucrase';

const ROOT = path.resolve(process.cwd());
const PORT = Number(process.env.PORT || 5174);
const HOST = process.env.HOST || '127.0.0.1';
const REACT = '19.2.8', RDOM = '19.2.8', RR = '7.18.3';
const CDN = 'https://esm.sh';

// Build Tailwind CSS once at startup.
const CSS_OUT = path.join(os.tmpdir(), 'exam-platform-preview.css');
try {
  execFileSync(path.join(ROOT, 'node_modules/.bin/tailwindcss'),
    ['-i', 'src/index.css', '-o', CSS_OUT, '--minify'],
    { cwd: ROOT, stdio: 'ignore' });
  console.log('[preview] tailwind css built ->', CSS_OUT);
} catch (e) { console.warn('[preview] tailwind build failed:', e.message); }

const IMPORTMAP = {
  imports: {
    'react': `${CDN}/react@${REACT}`,
    'react/jsx-runtime': `${CDN}/react@${REACT}/jsx-runtime`,
    'react/jsx-dev-runtime': `${CDN}/react@${REACT}/jsx-dev-runtime`,
    'react-dom': `${CDN}/react-dom@${RDOM}?deps=react@${REACT}`,
    'react-dom/client': `${CDN}/react-dom@${RDOM}/client?deps=react@${REACT}`,
    'react-router-dom': `${CDN}/react-router-dom@${RR}?deps=react@${REACT},react-dom@${RDOM}&external=react,react-dom`,
    '@supabase/supabase-js': `${CDN}/@supabase/supabase-js@2`,
    'livekit-client': `${CDN}/livekit-client@2`,
  },
};

const HTML = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>exam-platform (preview)</title>
<link rel="stylesheet" href="/__preview.css"/>
<script type="importmap">${JSON.stringify(IMPORTMAP)}</script>
</head><body><div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
</body></html>`;
const EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs'];
function existsFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// Resolve a relative specifier to a web path (leading '/', relative to ROOT).
function resolveRel(fromFile, spec) {
  if (spec.endsWith('.css')) return '/__noop.js';
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, 'index' + e))];
  for (const c of candidates) if (existsFile(c)) return '/' + path.relative(ROOT, c).split(path.sep).join('/');
  return spec; // leave as-is; browser will 404 (visible in console)
}

// Rewrite relative + css import specifiers in transpiled source.
function rewrite(code, fromFile) {
  const re = /(from\s*|import\s*|import\(\s*)(["'])([^"']+)\2/g;
  return code.replace(re, (m, kw, q, spec) => {
    if (spec.startsWith('./') || spec.startsWith('../')) return `${kw}${q}${resolveRel(fromFile, spec)}${q}`;
    if (spec.endsWith('.css')) return `${kw}${q}/__noop.js${q}`;
    return m; // bare specifier -> import map / CDN
  });
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') return send(res, 200, 'text/html; charset=utf-8', HTML);
  if (urlPath === '/__preview.css') {
    const css = existsFile(CSS_OUT) ? fs.readFileSync(CSS_OUT) : '/* css unavailable */';
    return send(res, 200, 'text/css; charset=utf-8', css);
  }
  if (urlPath === '/__noop.js') return send(res, 200, 'application/javascript', 'export default {};');
  if (urlPath === '/favicon.svg') {
    const f = path.join(ROOT, 'public/favicon.svg');
    return existsFile(f) ? send(res, 200, 'image/svg+xml', fs.readFileSync(f)) : send(res, 204, 'text/plain', '');
  }
  // Vite-style static fallback: serve from /public when a path doesn't resolve
  // at the repo root. This lets /downloads/* (staged installers), /icons.svg,
  // etc. work in the lite preview server exactly like `npm run dev`.
  const candidates = [];
  candidates.push(path.join(ROOT, urlPath));
  if (!urlPath.startsWith('/__')) candidates.push(path.join(ROOT, 'public', urlPath));
  const filePath = candidates.find((c) => c.startsWith(ROOT) && existsFile(c));
  if (!filePath) return send(res, 404, 'text/plain', 'Not found: ' + urlPath);
  const ext = path.extname(filePath);
  if (['.tsx', '.ts', '.jsx'].includes(ext)) {
    try {
      const src = fs.readFileSync(filePath, 'utf8');
      const out = transform(src, { transforms: ['typescript', 'jsx'], jsxRuntime: 'automatic', production: false, filePath }).code;
      return send(res, 200, 'application/javascript', rewrite(out, filePath));
    } catch (e) {
      return send(res, 500, 'application/javascript', `console.error(${JSON.stringify('Transpile error in ' + urlPath + ': ' + e.message)});`);
    }
  }
  if (ext === '.js' || ext === '.mjs') return send(res, 200, 'application/javascript', rewrite(fs.readFileSync(filePath, 'utf8'), filePath));
  if (ext === '.css') return send(res, 200, 'text/css', fs.readFileSync(filePath));
  if (ext === '.svg') return send(res, 200, 'image/svg+xml', fs.readFileSync(filePath));
  return send(res, 200, 'application/octet-stream', fs.readFileSync(filePath));
});

server.listen(PORT, HOST, () => console.log(`[preview] exam-platform running at http://${HOST}:${PORT}`));

