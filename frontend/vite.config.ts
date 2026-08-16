import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: '模拟面试助手',
        short_name: '模拟面试',
        description: 'AI 模拟面试练习助手',
        lang: 'zh-CN',
        display: 'standalone',
        start_url: '/',
        background_color: '#ffffff',
        theme_color: '#171717',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        // App shell only: offline opens "/"; deep links need network (spec Non-goal).
        navigateFallback: '/index.html',
        navigateFallbackAllowlist: [/^\/$/],
      },
    }),
  ],
})
