// @ts-check
import { defineConfig } from 'astro/config';

// static output 固定。SSR アダプタは入れない。
export default defineConfig({
  site: 'https://pw.elni.net',
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
});
