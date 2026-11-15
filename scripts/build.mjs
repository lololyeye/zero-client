import { build } from 'esbuild';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';

const dev = process.argv.includes('--dev');
await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
// The version is built into the code: a quick update runs newer code than the installed package.json says.
const common = { define: { __ZERO_VERSION__: JSON.stringify(version) }, bundle: true, sourcemap: dev ? 'inline' : false, minify: !dev, logLevel: 'info', target: 'es2022' };
// Entry point: picks the installed code or a verified app package (see src/boot/index.ts).
await build({ ...common, entryPoints: ['src/boot/index.ts'], outfile: 'dist/boot.js', platform: 'node', format: 'cjs', external: ['electron', 'original-fs'] });
await build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', platform: 'node', format: 'cjs', external: ['electron', 'original-fs'] });
await build({ ...common, entryPoints: ['src/preload/settings.ts'], outfile: 'dist/preload/settings.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/discord.ts'], outfile: 'dist/preload/discord.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/renderer/settings.ts'], outfile: 'dist/renderer/settings.js', platform: 'browser', format: 'iife' });
await build({ ...common, entryPoints: ['src/preload/picker.ts'], outfile: 'dist/preload/picker.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/renderer/picker.ts'], outfile: 'dist/renderer/picker.js', platform: 'browser', format: 'iife' });
await build({ ...common, entryPoints: ['src/preload/update.ts'], outfile: 'dist/preload/update.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/renderer/update.ts'], outfile: 'dist/renderer/update.js', platform: 'browser', format: 'iife' });
await build({ ...common, entryPoints: ['src/preload/voiceoverlay.ts'], outfile: 'dist/preload/voiceoverlay.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/renderer/voiceoverlay.ts'], outfile: 'dist/renderer/voiceoverlay.js', platform: 'browser', format: 'iife' });
await cp('src/renderer/voiceoverlay.html', 'dist/renderer/voiceoverlay.html');
await cp('src/renderer/voiceoverlay.css', 'dist/renderer/voiceoverlay.css');
await cp('src/renderer/update.html', 'dist/renderer/update.html');
await cp('src/renderer/update.css', 'dist/renderer/update.css');
await cp('src/renderer/picker.html', 'dist/renderer/picker.html');
await cp('src/renderer/picker.css', 'dist/renderer/picker.css');
await cp('src/renderer/settings.html', 'dist/renderer/settings.html');
await cp('src/renderer/settings.css', 'dist/renderer/settings.css');
