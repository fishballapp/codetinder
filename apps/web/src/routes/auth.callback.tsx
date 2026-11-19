import { createFileRoute } from '@tanstack/react-router';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { AuthCallback } from '../auth/AuthCallback';

/** A parameter GitLab sent, or none when it is missing or not text: sign-in then fails plainly. */
const Param = Schema.optional(Schema.String.pipe(Schema.catchDecoding(() => Effect.succeedNone)));

const RouteComponent = () => {
  const { code = '', state = '' } = Route.useSearch();
  return <AuthCallback code={code} state={state} />;
};

export const Route = createFileRoute('/auth/callback')({
  validateSearch: Schema.toStandardSchemaV1(Schema.Struct({ code: Param, state: Param })),
  component: RouteComponent,
});
