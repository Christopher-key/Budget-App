import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist');
const mode = process.argv[2] ?? 'build';
if (!['build', 'dev', 'preview'].includes(mode)) throw new Error('Choose build, dev or preview.');

if (mode === 'preview') {
  const server = await context({});
  const address = await server.serve({ servedir: output, fallback: join(output, 'index.html'), host: '127.0.0.1', port: 4173 });
  console.log(`Website preview: http://127.0.0.1:${address.port}`);
} else {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  // configure.mjs creates only public runtime config and security headers here.
  await cp(join(root, 'public'), output, { recursive: true });
  const template = await readFile(join(root, 'index.html'), 'utf8');
  const entry = '<script type="module" src="/src/main.tsx"></script>';
  if (template.split(entry).length !== 2 || !template.includes('</head>')) {
    throw new Error('The website template must contain one application entry and a closing head tag.');
  }
  const html = template.replace(entry, '<script type="module" src="/assets/app.js"></script>')
    .replace('</head>', '<link rel="stylesheet" href="/assets/app.css"/></head>');
  await writeFile(join(output, 'index.html'), html);

  const options = {
    absWorkingDir: root,
    entryPoints: ['src/main.tsx'],
    outfile: join(output, 'assets/app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    sourcemap: false,
    minify: mode === 'build',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode === 'build' ? 'production' : 'development') },
    logLevel: 'info',
  };
  if (mode === 'build') await build(options);
  else {
    const server = await context(options);
    await server.watch();
    const address = await server.serve({ servedir: output, fallback: join(output, 'index.html'), host: '127.0.0.1', port: 5173 });
    console.log(`Development website: http://127.0.0.1:${address.port} (refresh after changes)`);
  }
}
