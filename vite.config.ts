import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import os from 'os';

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    '__LOCAL_IP__': JSON.stringify(getLocalIP()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'masked-icon.svg'],
      manifest: {
        name: 'Vignan Exam Platform',
        short_name: 'Vignan Exams',
        description: 'Secure exam platform',
        theme_color: '#ffffff',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp}'],
        navigateFallback: '/index.html',
        navigateFallbackAllowlist: [/^\/student/],
        maximumFileSizeToCacheInBytes: 5000000
      }
    })
  ],
  server: { host: true, port: Number(process.env.PORT) || 5173, allowedHosts: true },
  build: {
    sourcemap: true,
  },
})
