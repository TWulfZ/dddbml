/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { copyFileSync } from 'fs';

// Copy the codicon font + stylesheet into the webview dist root after each bundle.
// They must live under dist/webview because that is the panel's only localResourceRoot
// (see panel.ts), and emptyOutDir wipes the dir every build — so copy on closeBundle,
// which fires in both `vite build` and `vite build --watch`.
function copyCodicons(): Plugin {
  const src = resolve(__dirname, 'node_modules/@vscode/codicons/dist');
  const out = resolve(__dirname, 'dist/webview');
  return {
    name: 'copy-codicons',
    closeBundle() {
      copyFileSync(resolve(src, 'codicon.css'), resolve(out, 'codicon.css'));
      copyFileSync(resolve(src, 'codicon.ttf'), resolve(out, 'codicon.ttf'));
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src/webview'),
  plugins: [copyCodicons()],
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
