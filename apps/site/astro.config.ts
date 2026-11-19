import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import { marketing } from '@internal/marketing/integration';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

/** The marketing site: static pages for search engines, the swipe demo and the waitlist form as its React islands. */
export default defineConfig({
  site: 'https://codetinder.dev',
  // One file per page (`/privacy` → privacy.html), so the Worker finds a page by its path alone.
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [react(), sitemap(), marketing()],
  vite: { plugins: [tailwindcss()] },
});
