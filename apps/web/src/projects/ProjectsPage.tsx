import { useAtomValue } from '@effect/atom-react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { Failure } from '../Failure';
import { PageNotice } from '../PageNotice';
import { SignInNotice } from '../SignInNotice';
import { projectsAtom } from '../state/atoms';
import { ProjectsScreen } from './ProjectsScreen';

const ProjectsSignIn = ({ isStarting }: { readonly isStarting: boolean }) => (
  <SignInNotice title="Sign in to add CodeTinder" isStarting={isStarting}>
    CodeTinder works in your GitLab projects, so it needs to know which ones are yours. Sign in and
    you'll land right back here.
  </SignInNotice>
);

/** Your projects; signed out, a sign-in first, started at once when the visitor asked for it. */
export const ProjectsPage = ({ signIn }: { readonly signIn: boolean }) =>
  AsyncResult.builder(useAtomValue(projectsAtom))
    .onInitial(() => <PageNotice title="Fetching your projects…" isWaiting />)
    .onErrorTag('SignedOut', () => <ProjectsSignIn isStarting={signIn} />)
    .onErrorTag('InvalidToken', () => <ProjectsSignIn isStarting={signIn} />)
    .onSuccess(projects => <ProjectsScreen projects={projects} />)
    .onFailure(cause => (
      <Failure cause={cause}>
        <PageNotice
          title="Couldn't load your projects"
          action={{ label: 'Try again', onClick: () => window.location.reload() }}
        >
          GitLab didn't answer this time. Nothing changed in any project.
        </PageNotice>
      </Failure>
    ))
    .render();
