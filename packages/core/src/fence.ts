/**
 * Strips an optional surrounding markdown code fence (```json ... ``` or ``` ... ```) from text.
 */
export const stripCodeFence = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) {
    return trimmed;
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 2) return trimmed;
  if (!lines[0]?.startsWith('```') || lines.at(-1) !== '```') return trimmed;
  // If an intermediate line closes the fence, it's not a single surrounding fence.
  for (let i = 1; i < lines.length - 1; i++) {
    if (lines[i] === '```') return trimmed;
  }
  return lines.slice(1, -1).join('\n').trim();
};

const longestBacktickRun = (text: string): number =>
  (text.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);

/** Fenced by a run of backticks longer than any in the text, so the text can't close the fence. */
export const fence = (text: string): string => {
  const ticks = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${ticks}\n${text}\n${ticks}`;
};

/** An inline code span the text can't close; padded when the text starts or ends with a backtick. */
export const code = (text: string): string => {
  const ticks = '`'.repeat(longestBacktickRun(text) + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${ticks}${padded}${ticks}`;
};
