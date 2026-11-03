import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(root + 'public', { recursive: true });
// Only a public API origin is exposed to the browser. Secrets are backend-only.
const apiText = process.env.VITE_API_BASE_URL?.trim() ?? '';
let config = { configured: false };
let connect = "'self'";
if (apiText) {
  let api;
  try { api = new URL(apiText); }
  catch { throw new Error('Provide a valid public account-service origin.'); }
  const localAPI = ['localhost', '127.0.0.1'].includes(api.hostname);
  const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
  if ((api.protocol !== 'https:' && !(!production && localAPI && api.protocol === 'http:')) ||
      api.username || api.password || api.search || api.hash || api.pathname !== '/') {
    throw new Error('Provide the HTTPS account-service origin only, without /api or credentials.');
  }
  config = { configured: true, apiBaseUrl: api.origin };
  connect += ` ${api.origin}`;
}
writeFileSync(root + 'public/config.json', JSON.stringify(config));
const policy = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connect}; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`;
const swa = {
  navigationFallback: { rewrite: '/index.html', exclude: ['/api/*', '/*.{css,js,svg,json,webmanifest}'] },
  globalHeaders: {
    'Content-Security-Policy': policy, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=()',
    'Cache-Control': 'no-store', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  },
  routes: [{ route: '/api/*', headers: { 'Cache-Control': 'no-store' } }]
};
writeFileSync(root + 'public/staticwebapp.config.json', JSON.stringify(swa, null, 2));
