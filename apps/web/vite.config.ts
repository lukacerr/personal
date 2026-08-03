import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), reactRouter()],
	preview: {
		host: '127.0.0.1',
	},
	resolve: {
		tsconfigPaths: true,
	},
	server: {
		watch: {
			usePolling: process.env.DOCKER_DEV === 'true',
			interval: 250,
		},
	},
});
