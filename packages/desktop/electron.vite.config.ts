import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const sharedAlias = resolve(__dirname, '../shared/src/index.ts');
const serverAlias = resolve(__dirname, '../server/src/index.ts');

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@openmeet/shared': sharedAlias,
        '@openmeet/server': serverAlias
      }
    },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: ['node-turn', 'bufferutil', 'utf-8-validate']
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@openmeet/shared': sharedAlias
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@openmeet/shared': sharedAlias
      }
    },
    plugins: [
      react(),
      {
        name: 'openmeet-production-csp',
        transformIndexHtml(html, context) {
          if (context.server) return html;
          const policy = [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            "font-src 'self' data:",
            "connect-src 'self' http: https: ws: wss:",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'"
          ].join('; ');
          return html.replace(
            '<head>',
            `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`
          );
        }
      }
    ]
  }
});
