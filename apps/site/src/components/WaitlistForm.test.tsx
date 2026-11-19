import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WaitlistForm } from './WaitlistForm';

/** The opening tag of the first element of `tag` whose tag text contains `marker`. */
const openingTag = (html: string, tag: string, marker: string): string | undefined =>
  html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g'))?.find(candidate => candidate.includes(marker));

describe('the waitlist form', () => {
  const html = renderToString(<WaitlistForm />);

  it('keeps PostHog autocapture off the form', () => {
    expect(openingTag(html, 'form', 'ph-no-capture')).toBeDefined();
  });

  it("keeps PostHog autocapture off the address's field", () => {
    expect(openingTag(html, 'input', 'type="email"')).toContain('ph-no-capture');
  });
});
