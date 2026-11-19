import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';

/**
 * The run's account in plain words, one markdown line per outcome, which the flow's last step
 * shows on the Duo session page. In `/tmp/codetinder/` with the run's other files.
 */
export const SESSION_LOG_FILE = '/tmp/codetinder/session.md';

/** `text` as a sentence: a reason quoted at its end often has no full stop of its own. */
const asSentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Adds a line to the session log. Never fails: the log only tells the developer what happened, so
 * a line it can't write never changes what the step does.
 */
export const logSession = Effect.fn('sessionLog.append')(
  function* (line: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(SESSION_LOG_FILE), { recursive: true });
    yield* fs.writeFileString(SESSION_LOG_FILE, `- ${asSentence(line)}\n`, { flag: 'a' });
  },
  effect => Effect.ignore(effect),
);
