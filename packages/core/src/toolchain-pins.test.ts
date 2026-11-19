import { describe, expect, it } from 'vitest';
import { pinnedCommand, readPins } from './toolchain-pins';

describe('readPins', () => {
  describe('package manager', () => {
    it('pins pnpm to packageManager, stripping the +sha suffix', () => {
      expect(
        readPins({
          fileNames: ['pnpm-lock.yaml'],
          packageJson: JSON.stringify({ packageManager: 'pnpm@12.6.0+sha512.abc123' }),
        }),
      ).toEqual({ packageManager: 'pnpm@12.6.0' });
    });

    it('defaults pnpm to pnpm@10 without a packageManager pin', () => {
      expect(readPins({ fileNames: ['pnpm-lock.yaml'] })).toEqual({ packageManager: 'pnpm@10' });
      expect(readPins({ fileNames: ['pnpm-lock.yaml'], packageJson: JSON.stringify({}) })).toEqual({
        packageManager: 'pnpm@10',
      });
    });

    it('defaults pnpm to pnpm@10 for a packageManager that is not a pnpm version', () => {
      expect(
        readPins({
          fileNames: ['pnpm-lock.yaml'],
          packageJson: JSON.stringify({ packageManager: 'npm@11.0.0' }),
        }),
      ).toEqual({ packageManager: 'pnpm@10' });
    });

    it('pins Yarn 1 to packageManager and leaves Yarn 2+ as yarn@1', () => {
      expect(
        readPins({
          fileNames: ['yarn.lock'],
          packageJson: JSON.stringify({ packageManager: 'yarn@1.22.22' }),
        }),
      ).toEqual({ packageManager: 'yarn@1.22.22' });
      expect(
        readPins({
          fileNames: ['yarn.lock'],
          packageJson: JSON.stringify({ packageManager: 'yarn@4.5.0' }),
        }),
      ).toEqual({ packageManager: 'yarn@1' });
    });

    it('pins no package manager for npm, which Duo’s image has', () => {
      expect(
        readPins({
          fileNames: ['package-lock.json'],
          packageJson: JSON.stringify({ packageManager: 'pnpm@12.6.0' }),
        }),
      ).toEqual({});
    });

    it('takes the lockfile the setup picks when several are present', () => {
      expect(readPins({ fileNames: ['package-lock.json', 'yarn.lock'] })).toEqual({});
      expect(readPins({ fileNames: ['pnpm-lock.yaml', 'yarn.lock'] })).toEqual({
        packageManager: 'pnpm@10',
      });
    });
  });

  describe('Node version', () => {
    it('reads the first number of an engines.node range', () => {
      expect(
        readPins({
          fileNames: [],
          packageJson: JSON.stringify({ engines: { node: '>=26' } }),
        }),
      ).toEqual({ nodeMajor: 26 });
      expect(
        readPins({
          fileNames: [],
          packageJson: JSON.stringify({ engines: { node: '^24.1' } }),
        }),
      ).toEqual({ nodeMajor: 24 });
      expect(
        readPins({
          fileNames: [],
          packageJson: JSON.stringify({ engines: { node: '>=22 <27' } }),
        }),
      ).toEqual({ nodeMajor: 22 });
    });

    it('reads a .nvmrc or .node-version pin, which wins over engines.node', () => {
      expect(
        readPins({
          fileNames: [],
          packageJson: JSON.stringify({ engines: { node: '>=24' } }),
          nodeVersionFile: '26\n',
        }),
      ).toEqual({ nodeMajor: 26 });
      expect(readPins({ fileNames: [], nodeVersionFile: 'v26.1.0' })).toEqual({ nodeMajor: 26 });
    });

    it('falls back to engines.node when the version file has no number', () => {
      expect(
        readPins({
          fileNames: [],
          packageJson: JSON.stringify({ engines: { node: '>=26' } }),
          nodeVersionFile: 'lts/*',
        }),
      ).toEqual({ nodeMajor: 26 });
    });

    it('pins no Node for Node 20 or below, or an unknown version', () => {
      expect(
        readPins({ fileNames: [], packageJson: JSON.stringify({ engines: { node: '>=20' } }) }),
      ).toEqual({});
      expect(readPins({ fileNames: [], nodeVersionFile: '18' })).toEqual({});
      expect(readPins({ fileNames: [] })).toEqual({});
    });

    it('treats an invalid package.json as unknown', () => {
      expect(
        readPins({ fileNames: ['pnpm-lock.yaml'], packageJson: '{ "packageManager": ' }),
      ).toEqual({ packageManager: 'pnpm@10' });
    });
  });
});

describe('pinnedCommand', () => {
  it('leaves the command unchanged when nothing is pinned', () => {
    expect(pinnedCommand('npm test', {})).toBe('npm test');
  });

  it('runs the command on the pinned Node and package manager', () => {
    expect(
      pinnedCommand('pnpm install --frozen-lockfile', {
        nodeMajor: 26,
        packageManager: 'pnpm@12.6.0',
      }),
    ).toBe(
      "npx --yes --foreground-scripts -p node@26 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile'",
    );
  });

  it('runs the command on a pinned package manager alone', () => {
    expect(pinnedCommand('pnpm test', { packageManager: 'pnpm@10' })).toBe(
      "npx --yes --foreground-scripts -p pnpm@10 -- sh -c 'pnpm test'",
    );
  });

  it('quotes a single quote in the command for sh', () => {
    expect(pinnedCommand("echo 'hi' && pnpm test", { packageManager: 'pnpm@10' })).toBe(
      "npx --yes --foreground-scripts -p pnpm@10 -- sh -c 'echo '\\''hi'\\'' && pnpm test'",
    );
  });
});
