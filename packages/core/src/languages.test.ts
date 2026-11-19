import { describe, expect, it } from 'vitest';
import { languagesOf } from './languages';

describe('languagesOf', () => {
  it.each([
    ['src/f.ts', ['TypeScript']],
    ['src/App.TSX', ['TypeScript']],
    ['types.d.ts', ['TypeScript']],
    ['index.mjs', ['JavaScript']],
    ['app/main.py', ['Python']],
    ['cmd/main.go', ['Go']],
    ['src/lib.rs', ['Rust']],
    ['Main.kt', ['Kotlin']],
    ['Program.cs', ['C#']],
    ['engine.cpp', ['C++']],
    ['engine.c', ['C']],
    ['scripts/build.sh', ['Shell']],
  ])('reads %s as %j', (path, languages) => {
    expect(languagesOf([path])).toEqual(new Set(languages));
  });

  it('reads a .h header as both C and C++, which its extension cannot tell apart', () => {
    expect(languagesOf(['include/x.h'])).toEqual(new Set(['C++', 'C']));
  });

  it('finds no language for a file without a section, or without an extension', () => {
    for (const path of ['README.md', 'src/Main.elm', 'Makefile', '.gitignore', 'dir.ts/file']) {
      expect(languagesOf([path])).toEqual(new Set());
    }
  });

  it('collects the distinct languages of the paths', () => {
    expect(languagesOf(['a.ts', 'b.tsx', 'c.py', 'README.md'])).toEqual(
      new Set(['TypeScript', 'Python']),
    );
  });
});
