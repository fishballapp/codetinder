import { useAtomValue } from '@effect/atom-react';
import { Navigate } from '@tanstack/react-router';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { Failure } from '../Failure';
import { PageNotice } from '../PageNotice';
import { SignInNotice } from '../SignInNotice';
import { projectsAtom } from '../state/atoms';
import { ProjectScreen } from './ProjectScreen';

const ProjectSignIn = () => (
  <SignInNotice title="Sign in to see your match">
    A project's page lives in GitLab, so CodeTinder needs to know it's yours. Sign in and you'll
    land right back here.
  </SignInNotice>
);

/**
 * One of the developer's matches. A project that isn't one (a removal finished, a stale link) goes
 * back to the list.
 */
export const ProjectPage = ({ id }: { readonly id: string }) =>
  AsyncResult.builder(useAtomValue(projectsAtom))
    .onInitial(() => <PageNotice title="Fetching your match…" isWaiting />)
    .onErrorTag('SignedOut', () => <ProjectSignIn />)
    .onErrorTag('InvalidToken', () => <ProjectSignIn />)
    .onSuccess(projects => {
      const project = projects.find(project => String(project.id) === id);
      if (project === undefined || project.state._tag === 'NotAdded') {
        return <Navigate to="/projects" replace />;
      }
      return <ProjectScreen project={project} projects={projects} />;
    })
    .onFailure(cause => (
      <Failure cause={cause}>
        <PageNotice
          title="Couldn't load your match"
          action={{ label: 'Try again', onClick: () => window.location.reload() }}
        >
          GitLab didn't answer this time. Nothing changed in the project.
        </PageNotice>
      </Failure>
    ))
    .render();
