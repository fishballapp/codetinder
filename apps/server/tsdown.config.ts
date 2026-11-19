import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { server: 'src/main.ts' },
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
