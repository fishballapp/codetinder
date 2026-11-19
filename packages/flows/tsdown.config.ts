import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { release: 'src/release.ts' },
  platform: 'node',
  target: 'node20',
  format: 'esm',
  fixedExtension: false,
  dts: false,
  deps: {
    alwaysBundle: [/.*/],
    onlyImport: [],
    onlyBundle: false,
  },
});
