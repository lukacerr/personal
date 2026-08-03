import { generateSW } from 'workbox-build';

if (!(await Bun.file('build/client/index.html').exists())) {
	throw new Error('React Router did not generate the SPA app shell');
}

const { count, size, warnings } = await generateSW({
	globDirectory: 'build/client',
	globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,woff2}'],
	swDest: 'build/client/sw.js',
	navigateFallback: 'index.html',
	cleanupOutdatedCaches: true,
	clientsClaim: true,
	skipWaiting: true,
	sourcemap: false,
});

if (warnings.length > 0) throw new Error(warnings.join('\n'));
if (count === 0) throw new Error('PWA build did not find app-shell assets');

console.log(`PWA app shell: ${count} files, ${size} bytes`);
