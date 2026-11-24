import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The client is always served as a production build by the board server.
// There is no dev server: one process, one port.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
})
