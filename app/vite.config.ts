import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: fileURLToPath(new URL('..', import.meta.url)), // one .env for server and app
  server: { port: 5174 }, // localhost only; `npm run dev -- --host` to reach it from a phone
  build: { target: 'esnext', outDir: 'dist', emptyOutDir: true },
})
