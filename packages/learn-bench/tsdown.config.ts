import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { 'learn-bench': 'src/main.ts' },
  platform: 'node',
  target: 'node26',
  format: 'esm',
  fixedExtension: false,
  dts: false,
  deps: {
    alwaysBundle: [/.*/],
    onlyImport: [],
    onlyBundle: false,
  },
});
