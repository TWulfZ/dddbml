/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'src/webview'),
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom/test-utils': 'preact/test-utils',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    outDir: resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/webview/main.tsx'),
      output: {
        entryFileNames: 'webview.js',
        assetFileNames: 'webview[extname]',
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
    sourcemap: false,
    target: 'es2022',
    minify: false,
  },
  test: {
    // Tests live across src/{webview,extension,shared}; webview-only root would skip extension specs.
    dir: resolve(__dirname, 'src'),
    include: ['**/*.test.ts'],
  },
});
