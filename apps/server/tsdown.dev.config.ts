import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { 'server-dev': 'src/dev.ts' },
  platform: 'node',
  target: 'node24',
  format: 'esm',
  fixedExtension: false,
  dts: false,
  deps: {
    alwaysBundle: [/.*/],
    onlyImport: [],
    onlyBundle: false,
  },
});
