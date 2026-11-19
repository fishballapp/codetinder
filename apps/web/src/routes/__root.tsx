import { createRootRoute, type ErrorComponentProps, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { PageNotice } from '../PageNotice';

const NotFound = () => (
  <PageNotice title="No page here">
    Nothing lives at this address. The heart up top takes you home.
  </PageNotice>
);

/** A page that threw while rendering: one plain sentence for the visitor, the error for the console. */
const RenderFailure = ({ error }: ErrorComponentProps) => {
  useEffect(() => {
    // biome-ignore lint/suspicious/noConsole: an error no page handles must stay findable.
    console.error(error);
  }, [error]);
  return <PageNotice title="Something went wrong">Reload to try again.</PageNotice>;
};

export const Route = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: RenderFailure,
});
