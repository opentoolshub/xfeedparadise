const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/offscreen.js'],
  bundle: true,
  outfile: 'offscreen-bundle.js',
  format: 'esm',
  platform: 'browser',
  target: 'chrome100',
  minify: false,
  sourcemap: true,
}).then(() => {
  console.log('✅ Build complete: offscreen-bundle.js');
}).catch((error) => {
  console.error('❌ Build failed:', error);
  process.exit(1);
});
