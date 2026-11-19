import * as CliError from 'effect/cli/CliError';

/** Fails the command with one line on stderr, which the flow quotes in its note. */
export const userError = (cause: { readonly message: string }, message = cause.message) =>
  new CliError.UserError({ cause, userMessage: message });

/** A defect as one message, for the note that says a run hit an unexpected error. */
export const messageOf = (defect: unknown): string => {
  if (defect instanceof Error) return defect.message;
  // A tagged failure that isn't an Error, such as Effect's ConfigError, still carries a message.
  if (typeof defect === 'object' && defect !== null && 'message' in defect) {
    return String(defect.message);
  }
  if (typeof defect === 'string') return defect;
  return JSON.stringify(defect);
};
