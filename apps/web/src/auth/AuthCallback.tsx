import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { useRouter } from '@tanstack/react-router';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useEffect } from 'react';
import { Failure } from '../Failure';
import { PageNotice } from '../PageNotice';
import { authCallbackAtom, startSignInAtom } from '../state/atoms';

const signingIn = <PageNotice title="Signing you in…" isWaiting />;

/** Where GitLab sends the developer back: finishes signing in, then returns to where they started. */
export const AuthCallback = ({
  code,
  state,
}: {
  readonly code: string;
  readonly state: string;
}) => {
  const { history } = useRouter();
  const startSignIn = useAtomSet(startSignInAtom);
  const key = `${code}:${state}`;

  const result = useAtomValue(authCallbackAtom(key));

  useEffect(() => {
    if (AsyncResult.isSuccess(result)) {
      // The sign-in's own record of the page it began on, so it is a path, not a typed route.
      history.replace(result.value);
    }
  }, [result, history]);

  return AsyncResult.builder(result)
    .onInitial(() => signingIn)
    .onSuccess(() => signingIn)
    .onFailure(cause => (
      // Where the sign-in began is lost with it, so a new one starts from your projects.
      <Failure cause={cause}>
        <PageNotice
          title="Sign-in didn't finish"
          action={{ label: 'Try again', onClick: () => startSignIn('/projects') }}
        >
          GitLab sent you back without a sign-in we could use. Nothing changed.
        </PageNotice>
      </Failure>
    ))
    .render();
};
