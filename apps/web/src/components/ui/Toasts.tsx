import { Toast } from '@base-ui/react/toast';
import { cn } from '@codetinder/ui';
import { HeartBreakIcon, HeartIcon, XIcon } from '@phosphor-icons/react';
import { type ReactNode, useSyncExternalStore } from 'react';
import { toastManager } from '../../state/toasts';

const PHONE_QUERY = '(width < 40rem)';

const subscribeToPhoneQuery = (onChange: () => void) => {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

const useIsPhone = () =>
  useSyncExternalStore(subscribeToPhoneQuery, () => window.matchMedia(PHONE_QUERY).matches);

/** The mark a toast leads with, by what it reports: the save in flight, done, or refused. */
const TOAST_MARKS: Record<string, ReactNode> = {
  loading: (
    <HeartIcon
      weight="fill"
      className="animate-beat text-hot-pink motion-reduce:animate-none"
      aria-hidden="true"
    />
  ),
  success: (
    <HeartIcon
      weight="fill"
      className="animate-beat-once text-lipstick motion-reduce:animate-none"
      aria-hidden="true"
    />
  ),
  error: <HeartBreakIcon weight="fill" className="text-lipstick" aria-hidden="true" />,
};

const toastClass = cn(
  // Each toast's resting place. Collapsed, the ones behind peek out a little smaller; expanded (the
  // stack hovered or focused) they spread out. `--stack` is the way the stack grows from its edge.
  '[--peek:0.6rem] [--gap:0.6rem] [--scale:calc(max(0,1-var(--toast-index)*0.06))] [--height:var(--toast-frontmost-height,var(--toast-height))]',
  '[--collapsed-y:calc(var(--stack)*(var(--toast-index)*var(--peek)+(1-var(--scale))*var(--height)))]',
  '[--expanded-y:calc(var(--stack)*(var(--toast-offset-y)+var(--toast-index)*var(--gap)))]',
  'absolute inset-x-0 z-[calc(1000-var(--toast-index))] h-[var(--height)] rounded-[16px] bg-card text-ink shadow-lift select-none data-expanded:h-[var(--toast-height)]',
  'bottom-0 origin-bottom max-sm:top-0 max-sm:bottom-auto max-sm:origin-top',
  '[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+var(--collapsed-y)))_scale(var(--scale))]',
  'data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+var(--expanded-y)))]',
  // The gap between expanded toasts still counts as the stack, so the pointer can cross it.
  "after:absolute after:inset-x-0 after:top-full after:h-[calc(var(--gap)+1px)] after:content-[''] max-sm:after:top-auto max-sm:after:bottom-full",
  // In from its edge and back out to it, or out the way it was swiped; a finger moves it directly.
  '[transition:transform_450ms_var(--ease-out),opacity_300ms_var(--ease-out),height_150ms_var(--ease-out)] data-swiping:[transition:none]',
  'data-starting-style:opacity-0 data-ending-style:opacity-0 data-limited:opacity-0',
  'motion-safe:data-starting-style:[transform:translateY(calc(var(--stack)*-150%))]',
  'motion-safe:[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(calc(var(--stack)*-150%))]',
  'motion-safe:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]',
  'motion-safe:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]',
  'motion-safe:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--expanded-y))]',
  // Reduced motion: toasts fade in and out where they stand.
  'motion-reduce:[transition:opacity_200ms_var(--ease-out)]',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lipstick',
);

const ToastList = () => {
  const { toasts } = Toast.useToastManager();
  const isPhone = useIsPhone();
  return toasts.map(toast => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      swipeDirection={isPhone ? ['up', 'right'] : ['down', 'right']}
      className={toastClass}
    >
      <Toast.Content className="flex items-start gap-3 overflow-hidden py-3 pr-2 pl-4 transition-opacity duration-200 ease-out data-behind:opacity-0 data-expanded:opacity-100">
        <span className="flex h-[1.4rem] flex-none items-center text-[1.2rem]">
          {TOAST_MARKS[toast.type ?? '']}
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5 py-px">
          <Toast.Title className="text-[1rem] leading-[1.4] font-semibold text-ink" />
          <Toast.Description className="text-[0.95rem] leading-[1.45] text-pretty text-ink-soft empty:hidden" />
        </div>
        <Toast.Close
          aria-label="Dismiss"
          className="-my-2 grid size-11 flex-none cursor-pointer place-items-center rounded-full text-ink-faint transition-colors duration-150 hover:bg-card-sunk hover:text-wine focus-visible:outline-2 focus-visible:outline-lipstick [&_svg]:size-[1.05rem]"
        >
          <XIcon weight="bold" aria-hidden="true" />
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
};

/**
 * The app's toasts, raised anywhere through `toastManager`: a stack at the bottom right, and at
 * the top on phones, clear of the sections' footers at the bottom of the screen.
 */
export const Toasts = ({ children }: { readonly children: ReactNode }) => (
  <Toast.Provider toastManager={toastManager}>
    {children}
    <Toast.Portal>
      <Toast.Viewport className="fixed right-6 bottom-6 z-10 w-[23rem] [--stack:-1] max-sm:inset-x-3 max-sm:top-[calc(0.75rem+env(safe-area-inset-top))] max-sm:bottom-auto max-sm:w-auto max-sm:[--stack:1]">
        <ToastList />
      </Toast.Viewport>
    </Toast.Portal>
  </Toast.Provider>
);
