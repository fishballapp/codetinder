import * as Base64Url from 'effect/encoding/Base64Url';

/**
 * For tests: `DUO_WORKFLOW_ADDITIONAL_CONTEXT_CONTENT` as GitLab sets it, a JSON list of items
 * whose content is JSON, naming the event that started the run.
 */
export const triggerContext = (eventType: string, items: Record<string, object> = {}) =>
  JSON.stringify(
    Object.entries({ agent_platform_trigger_context: { event_type: eventType }, ...items }).map(
      ([Category, content]) => ({ Category, Content: JSON.stringify(content) }),
    ),
  );

/** For tests: the run's context for a merge request opened. */
export const MERGE_REQUEST_CONTEXT = triggerContext('merge_request');

/** For tests: the run's ID token, naming the flow's service account as GitLab's does. */
export const ID_TOKEN = [
  { alg: 'RS256', kid: 'kid' },
  { user_login: 'ai-codetinder-acme' },
  'signature',
]
  .map(part => Base64Url.encode(typeof part === 'string' ? part : JSON.stringify(part)))
  .join('.');
