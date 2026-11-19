import { useAtomValue } from '@effect/atom-react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { Failure } from '../Failure';
import { PageNotice } from '../PageNotice';
import { SignInNotice } from '../SignInNotice';
import { roundDetailsAtom } from '../state/atoms';
import { RoundScreen } from './RoundScreen';

const RoundSignIn = () => (
  <SignInNotice title="Sign in to swipe">
    Rounds are private: only people who can read the project's code get to see them. Sign in and
    you'll land right back here.
  </SignInNotice>
);

export const RoundPage = ({ id }: { readonly id: string }) => {
  const result = useAtomValue(roundDetailsAtom(id));

  return AsyncResult.builder(result)
    .onInitial(() => <PageNotice title="Fetching your round…" isWaiting />)
    .onErrorTag('SignedOut', () => <RoundSignIn />)
    .onErrorTag('Unauthorized', () => <RoundSignIn />)
    .onErrorTag('Forbidden', () => (
      <PageNotice title="Not your round to swipe">
        It belongs to a project your GitLab account can't read. Ask a Maintainer for access, then
        come back.
      </PageNotice>
    ))
    .onErrorTag('RoundNotFound', () => (
      <PageNotice title="No round here">
        Nothing matches this link. Check it against the one in CodeTinder's note on the merge
        request.
      </PageNotice>
    ))
    .onSuccess(({ round, myVerdicts }) => (
      <RoundScreen roundId={round.id} details={round} savedVerdicts={myVerdicts} />
    ))
    .onFailure(cause => (
      <Failure cause={cause}>
        <PageNotice
          title="Couldn't load the round"
          action={{ label: 'Try again', onClick: () => window.location.reload() }}
        >
          CodeTinder or GitLab didn't answer this time. Your swipes so far are safe.
        </PageNotice>
      </Failure>
    ))
    .render();
};
