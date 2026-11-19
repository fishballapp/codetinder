/** A GitLab ID token is a JWT (three base64url parts); an OAuth token is opaque. */
export type TokenKind = 'id-token' | 'oauth';

const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;

export const tokenKind = (token: string): TokenKind => {
  const parts = token.split('.');
  if (parts.length !== 3) return 'oauth';
  if (parts.every(part => part.length > 0 && BASE64URL_PART.test(part))) return 'id-token';
  return 'oauth';
};
