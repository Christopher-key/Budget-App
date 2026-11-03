import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(root + 'public', { recursive: true });
const names = ['VITE_AZURE_CLIENT_ID', 'VITE_AZURE_AUTHORITY', 'VITE_AZURE_SCOPE', 'VITE_API_BASE_URL'];
const supplied = names.map(name => process.env[name]?.trim() ?? '');
let config = { configured: false };
let connect = "'self'";
if (supplied.some(Boolean)) {
  if (!supplied.every(Boolean)) throw new Error('Provide all four public Azure web configuration values.');
  const [clientId, authorityText, scope, apiText] = supplied;
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error('Invalid public application ID.');
  const authority = new URL(authorityText);
  const api = new URL(apiText);
  if (authority.protocol !== 'https:' || authority.username || authority.password || authority.search || authority.hash ||
      !(authority.hostname === 'login.microsoftonline.com' || authority.hostname.endsWith('.ciamlogin.com'))) {
    throw new Error('Use the exact Microsoft tenant authority over HTTPS.');
  }
  const localAPI = api.hostname === 'localhost' || api.hostname === '127.0.0.1';
  if ((api.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && localAPI && api.protocol === 'http:')) ||
      api.username || api.password || api.search || api.hash || api.pathname !== '/') throw new Error('Use the API origin only, such as https://your-function-app.azurewebsites.net (without /api).');
  if (!/^api:\/\/[0-9a-f-]{36}\/Budget\.Access$/i.test(scope)) throw new Error('Request only the registered Budget.Access API scope.');
  config = { configured: true, clientId, authority: authority.href.replace(/\/$/, ''), scope, apiBaseUrl: api.href.replace(/\/$/, '') };
  connect += ` ${authority.origin} ${api.origin}`;
}
writeFileSync(root + 'public/config.json', JSON.stringify(config));
const policy = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connect}; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`;
const swa = {
  navigationFallback: { rewrite: '/index.html', exclude: ['/api/*', '/*.{css,js,svg,json,webmanifest}'] },
  globalHeaders: {
    'Content-Security-Policy': policy, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cache-Control': 'no-store', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  },
  routes: [{ route: '/api/*', headers: { 'Cache-Control': 'no-store' } }]
};
writeFileSync(root + 'public/staticwebapp.config.json', JSON.stringify(swa, null, 2));
