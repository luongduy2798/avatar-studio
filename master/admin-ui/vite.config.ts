import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/admin.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (asset) => asset.name?.endsWith('.css')
          ? 'assets/styles.css'
          : 'assets/[name][extname]',
      },
    },
  },
})
