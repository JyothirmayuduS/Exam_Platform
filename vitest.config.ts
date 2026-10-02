import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

const srcRoot = path.resolve(__dirname, './src');

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['node_modules', 'tests-e2e', 'tests'],
  },
  resolve: {
    alias: {
      '@': srcRoot,
    },
  },
});
