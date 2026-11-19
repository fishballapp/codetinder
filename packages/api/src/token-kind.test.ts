import { describe, expect, it } from 'vitest';
import { tokenKind } from './token-kind';

describe('tokenKind', () => {
  it('detects a three-part base64url JWT as an id token', () => {
    expect(tokenKind('eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJnaXRsYWIifQ.signature')).toBe('id-token');
  });

  it('treats opaque OAuth tokens as oauth', () => {
    expect(tokenKind('oauth-opaque-token-value')).toBe('oauth');
    expect(tokenKind('single-segment-token')).toBe('oauth');
  });

  it('rejects JWT-shaped strings with empty or non-base64url parts', () => {
    expect(tokenKind('a..c')).toBe('oauth');
    expect(tokenKind('a.b+.c')).toBe('oauth');
    expect(tokenKind('only.two')).toBe('oauth');
    expect(tokenKind('a.b.c.d')).toBe('oauth');
  });
});
