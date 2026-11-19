import { Toast } from '@base-ui/react/toast';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';

/** The app's one toast manager: an atom or a handler raises a toast through it, with no hook. */
export const toastManager = Toast.createToastManager();

/** How long a success stays up; a failure stays until it is dismissed. */
const SUCCESS_TIMEOUT_MS = 4000;

/** What a write's toast says while it runs, once it succeeds, and when it fails. */
export type WriteToastCopy = {
  readonly loading: string;
  readonly success: string;
  readonly failureTitle: string;
  /** A refusal in the words of whoever refused it, GitLab or codetinder.dev, when it says one. */
  readonly refusal: (error: unknown) => string | undefined;
  /** No answer worth showing: GitLab or codetinder.dev unreachable, or the write cut off. */
  readonly noAnswer: string;
};

const failureText = <E>(cause: Cause.Cause<E>, { refusal, noAnswer }: WriteToastCopy): string => {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error)) return noAnswer;
  return refusal(error.value) ?? noAnswer;
};

/**
 * Runs `write` under a toast: `loading` from the moment it is asked for, even while it waits its
 * turn, then `success` for a few seconds, or the failure until it is dismissed.
 */
export const withWriteToast = <A, E, R>(
  write: Effect.Effect<A, E, R>,
  copy: WriteToastCopy,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const { promise, resolve, reject } = Promise.withResolvers<A>();
    toastManager
      .promise(promise, {
        loading: { title: copy.loading },
        success: { title: copy.success, timeout: SUCCESS_TIMEOUT_MS },
        error: (cause: Cause.Cause<E>) => ({
          title: copy.failureTitle,
          description: failureText(cause, copy),
          timeout: 0,
          priority: 'high',
        }),
      })
      // The toast is where a failure shows; the write's fiber carries the failure on.
      .catch(() => undefined);
    return write.pipe(
      Effect.onExit(exit =>
        Effect.sync(() => (Exit.isSuccess(exit) ? resolve(exit.value) : reject(exit.cause))),
      ),
    );
  });
