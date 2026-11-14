import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const dev = process.argv.includes('--dev');
await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: dev ? 'inline' : false, minify: !dev, logLevel: 'info', target: 'es2022' };
await build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/settings.ts'], outfile: 'dist/preload/settings.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/discord.ts'], outfile: 'dist/preload/discord.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/renderer/settings.ts'], outfile: 'dist/renderer/settings.js', platform: 'browser', format: 'iife' });
await build({ ...common, entryPoints: ['src/preload/picker.ts'], outfile: 'dist/preload/picker.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/renderer/picker.ts'], outfile: 'dist/renderer/picker.js', platform: 'browser', format: 'iife' });
await cp('src/renderer/picker.html', 'dist/renderer/picker.html');
await cp('src/renderer/picker.css', 'dist/renderer/picker.css');
await cp('src/renderer/settings.html', 'dist/renderer/settings.html');
await cp('src/renderer/settings.css', 'dist/renderer/settings.css');
