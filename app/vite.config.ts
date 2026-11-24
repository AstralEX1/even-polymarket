import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: fileURLToPath(new URL('..', import.meta.url)), // one .env for server and app
  envPrefix: ['VITE_', 'PUBLIC_URL'], // PUBLIC_URL is not secret: it becomes the default server of a packed app
  server: { port: 5174 }, // localhost only; `npm run dev -- --host` to reach it from a phone
  build: { target: 'esnext', outDir: 'dist', emptyOutDir: true },
})
