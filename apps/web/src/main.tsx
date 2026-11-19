import { RegistryProvider } from '@effect/atom-react';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toasts } from './components/ui/Toasts';
import { routeTree } from './routeTree.gen';
import './styles/global.css';

const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    readonly router: typeof router;
  }
}

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html has no #root to render into');
}
createRoot(container).render(
  <StrictMode>
    <RegistryProvider>
      <Toasts>
        <RouterProvider router={router} />
      </Toasts>
    </RegistryProvider>
  </StrictMode>,
);
