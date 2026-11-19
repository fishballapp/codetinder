import * as Cause from 'effect/Cause';
import { type ReactNode, useEffect } from 'react';

/**
 * The page's last resort: one plain sentence for the visitor (or `children`, a page's own way of
 * saying it), the whole cause for the console.
 */
export const Failure = ({
  cause,
  children,
}: {
  readonly cause: Cause.Cause<unknown>;
  readonly children?: ReactNode;
}) => {
  useEffect(() => {
    // biome-ignore lint/suspicious/noConsole: an outcome no page handles must stay findable.
    console.error(Cause.pretty(cause));
  }, [cause]);
  return children ?? <p>Something went wrong. Reload to try again.</p>;
};
