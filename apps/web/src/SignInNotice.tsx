import { GitLabMark } from '@codetinder/ui/react';
import { useAtomSet } from '@effect/atom-react';
import { useLocation } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef } from 'react';
import { PageNotice } from './PageNotice';
import { startSignInAtom } from './state/atoms';

/**
 * A page that needs GitLab: why, and a sign-in that comes straight back here. Arrived at from a
 * "Sign in" link (`isStarting`), it goes straight on to GitLab instead of asking twice, its heart
 * beating while the browser leaves.
 */
export const SignInNotice = ({
  title,
  isStarting = false,
  children,
}: {
  readonly title: string;
  readonly isStarting?: boolean;
  readonly children: ReactNode;
}) => {
  const startSignIn = useAtomSet(startSignInAtom);
  const pathname = useLocation({ select: location => location.pathname });
  // Once: StrictMode runs an effect twice, and each start writes a new sign-in state.
  const hasStarted = useRef(false);
  useEffect(() => {
    if (!isStarting || hasStarted.current) return;
    hasStarted.current = true;
    startSignIn(pathname);
  }, [isStarting, pathname, startSignIn]);
  if (isStarting) {
    return (
      <PageNotice title="Off to GitLab…" isWaiting>
        Sign in there and you'll land right back here.
      </PageNotice>
    );
  }
  return (
    <PageNotice
      title={title}
      action={{
        label: (
          <>
            <GitLabMark />
            Sign in with GitLab
          </>
        ),
        onClick: () => startSignIn(pathname),
      }}
    >
      {children}
    </PageNotice>
  );
};
