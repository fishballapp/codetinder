export const GITLAB_OAUTH_CLIENT_ID =
  '9f3e509e593bee2645d0671d497d659b6ab34ac437caec35da0354010e399b35';

export const getOAuthRedirectUri = (): string => `${window.location.origin}/auth/callback`;

/**
 * The marketing site's address for `path`. Both are served from one origin, so in production it is
 * the path itself; in development the site runs on its own port.
 */
export const siteUrl = (path: string): string =>
  import.meta.env.DEV ? `http://localhost:5174${path}` : path;
