import path from 'path';
import { defineConfig, loadEnv } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSass } from '@rsbuild/plugin-sass';

// Load production environment variables before reading source.define values.
loadEnv({ mode: 'production' });

const isStaticBuild = process.env.NEXT_PUBLIC_APP_BUILD === 'true';

// Resolve the package location for standalone and workspace installations.
const smartchartsDist = path.join(
  path.dirname(require.resolve('@deriv-com/smartcharts-champion/package.json')),
  'dist'
);

export default defineConfig({
  plugins: [
    pluginSass({
      sassLoaderOptions: { sourceMap: true },
      exclude: /node_modules/,
    }),
    pluginReact(),
  ],

  source: {
    entry: { index: './src/main.tsx' },
    define: {
      'process.env': {
        NEXT_PUBLIC_DERIV_APP_ID: JSON.stringify(
          process.env.NEXT_PUBLIC_DERIV_APP_ID ?? ''
        ),
        NEXT_PUBLIC_DERIV_ENV: JSON.stringify(
          process.env.NEXT_PUBLIC_DERIV_ENV ?? ''
        ),
        NEXT_PUBLIC_DERIV_REFERRAL_LINK: JSON.stringify(
          process.env.NEXT_PUBLIC_DERIV_REFERRAL_LINK ?? ''
        ),
        NEXT_PUBLIC_DERIV_APP_NAME: JSON.stringify(
          process.env.NEXT_PUBLIC_DERIV_APP_NAME ?? ''
        ),
        NEXT_PUBLIC_APP_BUILD: JSON.stringify(
          process.env.NEXT_PUBLIC_APP_BUILD ?? ''
        ),
        GD_CLIENT_ID: JSON.stringify(process.env.GD_CLIENT_ID),
        GD_APP_ID: JSON.stringify(process.env.GD_APP_ID),
        GD_API_KEY: JSON.stringify(process.env.GD_API_KEY),
      },
    },
  },

  resolve: {
    alias: {
      // Resolve React from its installed location, including hoisted workspaces.
      react: path.dirname(require.resolve('react/package.json')),
      'react-dom': path.dirname(require.resolve('react-dom/package.json')),
      '@/external': path.resolve(__dirname, './src/external'),
      '@/components': path.resolve(__dirname, './src/components'),
      '@/hooks': path.resolve(__dirname, './src/hooks'),
      '@/utils': path.resolve(__dirname, './src/utils'),
      '@/constants': path.resolve(__dirname, './src/constants'),
      '@/stores': path.resolve(__dirname, './src/stores'),
    },
  },

  output: {
    assetPrefix: isStaticBuild ? '/bot/preview/' : '/',
    distPath: {
      root: isStaticBuild ? 'out/preview' : 'dist',
    },
    copy: [
      {
        from: path.join(smartchartsDist, '*'),
        to: 'js/smartcharts/[name][ext]',
        globOptions: { ignore: ['**/*.LICENSE.txt'] },
      },

      // Preserve the Flutter/CanvasKit renderer's directory structure.
      {
        from: path.join(smartchartsDist, 'chart'),
        to: 'js/smartcharts/chart',
      },

      // Mirror assets at the public path used by SmartCharts.
      {
        from: path.join(smartchartsDist, 'assets'),
        to: 'js/smartcharts/assets',
      },
      {
        from: path.join(smartchartsDist, 'assets/*'),
        to: 'assets/[name][ext]',
      },
      {
        from: path.join(smartchartsDist, 'assets/fonts/*'),
        to: 'assets/fonts/[name][ext]',
      },
      {
        from: path.join(smartchartsDist, 'assets/shaders/*'),
        to: 'assets/shaders/[name][ext]',
      },
      {
        from: path.join(__dirname, 'public'),
      },
    ],
  },

  html: {
    template: './index.html',
  },

  server: {
    compress: true,
  },

  dev: {
    hmr: true,
  },

  tools: {
    rspack: {
      module: {
        rules: [
          {
            test: /\.xml$/,
            exclude: /node_modules/,
            use: 'raw-loader',
          },
        ],
      },
    },
  },
});
