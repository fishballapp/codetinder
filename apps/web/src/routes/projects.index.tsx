import { createFileRoute } from '@tanstack/react-router';
import * as Schema from 'effect/Schema';
import { ProjectsPage } from '../projects/ProjectsPage';

/** `?signIn`, on the site's sign-in links: a signed-out visitor goes straight on to GitLab. */
const SignIn = Schema.optional(Schema.Unknown);

const RouteComponent = () => {
  const { signIn } = Route.useSearch();
  return <ProjectsPage signIn={signIn !== undefined} />;
};

export const Route = createFileRoute('/projects/')({
  validateSearch: Schema.toStandardSchemaV1(Schema.Struct({ signIn: SignIn })),
  component: RouteComponent,
});
