import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const fromRoot = (file) => fileURLToPath(new URL(`../${file}`, import.meta.url));
await build({
  configFile: false,
  build: {
    ssr: fromRoot('server/api.ts'),
    outDir: fromRoot('dist-server'),
    emptyOutDir: true,
  },
});
if (process.platform === 'darwin') {
  const cache = fromRoot('node_modules/.cache/novelflow-swift');
  mkdirSync(cache, { recursive: true });
  execFileSync('xcrun', [
    'swiftc', '-O', '-module-cache-path', cache, fromRoot('server/ocr/video.swift'),
    '-o', fromRoot('dist-server/ocr-video'),
  ], { stdio: 'inherit' });
}
