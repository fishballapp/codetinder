import { describe, expect, it } from '@effect/vitest';
import { stripCodeFence } from './fence';

describe('stripCodeFence', () => {
  it('returns plain text unmodified', () => {
    expect(stripCodeFence('{"hello": "world"}')).toBe('{"hello": "world"}');
  });

  it('strips a ```json code fence', () => {
    const input = '```json\n{"hello": "world"}\n```';
    expect(stripCodeFence(input)).toBe('{"hello": "world"}');
  });

  it('strips a bare ``` code fence', () => {
    const input = '```\n{"hello": "world"}\n```';
    expect(stripCodeFence(input)).toBe('{"hello": "world"}');
  });

  it('strips code fences with leading and trailing whitespace', () => {
    const input = '  \n```json\n{"hello": "world"}\n```\n  ';
    expect(stripCodeFence(input)).toBe('{"hello": "world"}');
  });

  it('strips windows style CRLF fences', () => {
    const input = '```json\r\n{"hello": "world"}\r\n```';
    expect(stripCodeFence(input)).toBe('{"hello": "world"}');
  });

  it('does not strip multiple separate code blocks', () => {
    const input = '```json\n{"a": 1}\n```\nSome middle text\n```json\n{"b": 2}\n```';
    expect(stripCodeFence(input)).toBe(input);
  });
});
