import { createServer } from 'vite'

// Existing local Docker API; no container rebuild or server configuration change.
const server = await createServer({
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:8080', ws: true, changeOrigin: true },
    },
  },
})
await server.listen()
server.printUrls()
