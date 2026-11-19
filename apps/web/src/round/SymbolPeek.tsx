import type { ContextSnippet } from '@codetinder/core';
import { cn } from '@codetinder/ui';
import { CodeBlock, symbolClass } from '@codetinder/ui/react';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { Peek } from './Peek';

/**
 * Names in a definition aren't marked: only the card's names open definitions, one level deep, so
 * a peek never opens another peek on top of itself.
 */
const NO_SYMBOLS: readonly string[] = [];

/**
 * A name from the round's context, in a card's code: like an editor's hover, resting the mouse on
 * it shows its definition beside it, and a click keeps it open. A tap opens the definition in a
 * sheet from the bottom instead, where there is no hover. `fileUrl` links the file's path to the
 * definition on GitLab, once GitLab has said where it is.
 */
export const SymbolPeek = ({
  snippet,
  fileUrl,
}: {
  readonly snippet: ContextSnippet;
  readonly fileUrl?: string;
}) => {
  const where = (
    <p className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <code className="text-[0.95rem] font-bold text-ink">{snippet.symbol}</code>
      {fileUrl === undefined ? (
        <span className="text-[0.85rem] text-ink-faint">{snippet.file}</span>
      ) : (
        <a
          className="flex min-w-0 items-center gap-[0.4em] whitespace-nowrap text-[0.85rem] font-semibold text-wine hover:underline"
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`${snippet.file} on GitLab`}
        >
          {snippet.file}
          <ArrowSquareOutIcon className="size-[1em] flex-none" aria-hidden="true" />
        </a>
      )}
    </p>
  );

  return (
    <Peek
      isNativeButton={false}
      trigger={
        // A span, not a button: a button sits in the line as a box, which a card's wrapping code
        // may break either side of, stranding the `,` after the name on a line of its own.
        <span
          className={cn(
            symbolClass,
            'cursor-help rounded-[0.2em] hover:bg-[rgb(47_79_209/0.08)] hover:decoration-2',
          )}
        >
          {snippet.symbol}
        </span>
      }
      label={`${snippet.symbol}, from ${snippet.file}`}
      head={where}
      sheetChildren={
        // A phone's sheet wraps, as a card does under a finger: no sideways scrolling to read it.
        <CodeBlock text={snippet.text} symbols={NO_SYMBOLS} layout="wrap" />
      }
    >
      <CodeBlock text={snippet.text} symbols={NO_SYMBOLS} />
    </Peek>
  );
};
