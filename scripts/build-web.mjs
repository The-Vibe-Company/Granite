#!/usr/bin/env node
// Copy src/web/public → dist/public and minify .js / .css with esbuild.
// index.html and other assets are copied verbatim.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src/web/public');
const out = path.join(root, 'dist/public');

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const files = await walk(src);
const jsFiles = [];
const cssFiles = [];
const otherFiles = [];
for (const f of files) {
  if (f.endsWith('.js')) jsFiles.push(f);
  else if (f.endsWith('.css')) cssFiles.push(f);
  else otherFiles.push(f);
}

// Copy non-JS/CSS assets verbatim (index.html, svg, etc.)
for (const f of otherFiles) {
  const rel = path.relative(src, f);
  const dest = path.join(out, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(f, dest);
}

// Minify each JS file standalone (they rely on global window bindings).
for (const f of jsFiles) {
  const rel = path.relative(src, f);
  const dest = path.join(out, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await build({
    entryPoints: [f],
    outfile: dest,
    minify: true,
    bundle: false,
    format: 'iife',
    target: 'es2020',
    logLevel: 'error',
  });
}

// Smoke-test the compiled renderer. It is consumed by app.js through a browser
// global, so a successful minification must preserve both that global and its
// rendering behavior.
const rendererBundle = await fs.readFile(path.join(out, 'markdown-renderer.js'), 'utf8');
const rendererContext = vm.createContext({ window: {} });
vm.runInContext(rendererBundle, rendererContext, { filename: 'markdown-renderer.js' });

const renderer = rendererContext.window.MarkdownRenderer;
if (typeof renderer?.render !== 'function') {
  throw new Error('Compiled markdown renderer does not expose window.MarkdownRenderer.render');
}

const renderedMarkdown = renderer.render(
  '# Build check\nA paragraph with [[Granite]].',
  [{ target: 'Granite', resolved: true, resolved_slug: 'granite' }],
);
if (
  !renderedMarkdown.includes('<h1 class="md-h1">Build check</h1>')
  || !renderedMarkdown.includes('<p class="md-body">')
  || !renderedMarkdown.includes('class="wikilink"')
  || !renderedMarkdown.includes('data-slug="granite"')
) {
  throw new Error('Compiled markdown renderer failed its semantic smoke test');
}

// The app consumes the type-filter resolver through a browser global too.
// Verify the production asset keeps custom types while dropping empty ones.
const typeFiltersBundle = await fs.readFile(path.join(out, 'type-filters.js'), 'utf8');
const typeFiltersContext = vm.createContext({ window: {} });
vm.runInContext(typeFiltersBundle, typeFiltersContext, { filename: 'type-filters.js' });

const typeFilters = typeFiltersContext.window.GraniteTypeFilters;
const visibleTypes = typeFilters?.visibleTypeNames(
  { note: {}, source: {}, meeting: {} },
  [{ type: 'note' }, { type: 'meeting' }, { type: 'retro' }],
);
if (JSON.stringify(visibleTypes) !== JSON.stringify(['note', 'meeting', 'retro'])) {
  throw new Error('Compiled type-filter registry failed its semantic smoke test');
}
if (
  typeFilters.noteType(
    { slug: 'weekly-sync' },
    { 'weekly-sync': { type: 'meeting' } },
  ) !== 'meeting'
) {
  throw new Error('Compiled type-filter registry failed its legacy search compatibility check');
}

// Minify each CSS file.
for (const f of cssFiles) {
  const rel = path.relative(src, f);
  const dest = path.join(out, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await build({
    entryPoints: [f],
    outfile: dest,
    minify: true,
    bundle: false,
    loader: { '.css': 'css' },
    logLevel: 'error',
  });
}

const sizes = await Promise.all([...jsFiles, ...cssFiles].map(async (f) => {
  const rel = path.relative(src, f);
  const dest = path.join(out, rel);
  const [srcStat, outStat] = await Promise.all([fs.stat(f), fs.stat(dest)]);
  return { rel, src: srcStat.size, out: outStat.size };
}));

const srcTotal = sizes.reduce((a, b) => a + b.src, 0);
const outTotal = sizes.reduce((a, b) => a + b.out, 0);
console.log(`web assets: ${sizes.length} files, ${(srcTotal / 1024).toFixed(1)} KB → ${(outTotal / 1024).toFixed(1)} KB (${((1 - outTotal / srcTotal) * 100).toFixed(0)}% smaller)`);
