import { Drawer } from '@base-ui/react/drawer';
import { cn } from '@codetinder/ui';
import { XIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/**
 * A bottom sheet for touch: it slides up over a wine scrim and a swipe down, a tap outside or the
 * close button sends it away. `head` sits beside the close button.
 */
export const Sheet = ({
  open,
  onOpenChange,
  label,
  head,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly label: string;
  readonly head: ReactNode;
  readonly children: ReactNode;
}) => (
  <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="down">
    <Drawer.Portal>
      <Drawer.Backdrop className="fixed inset-0 min-h-dvh bg-[rgb(74_6_26)] opacity-[calc(0.4*(1_-_var(--drawer-swipe-progress)))] transition-opacity duration-[400ms] ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[swiping]:duration-[0ms]" />
      <Drawer.Viewport className="fixed inset-0 flex items-end">
        <Drawer.Popup
          className={cn(
            'max-h-[80dvh] w-full overflow-y-auto overscroll-contain rounded-[1.25rem_1.25rem_0_0] bg-card text-ink shadow-lift outline-0 focus-visible:outline-none',
            '[transform:translateY(var(--drawer-swipe-movement-y))] [transition:transform_400ms_var(--ease-out)]',
            'data-[ending-style]:[transform:translateY(100%)] data-[starting-style]:[transform:translateY(100%)]',
            'data-[swiping]:duration-[0ms] data-[ending-style]:[transition-duration:calc(var(--drawer-swipe-strength)*400ms)]',
            'motion-reduce:data-[ending-style]:opacity-0 motion-reduce:data-[ending-style]:[transform:none] motion-reduce:data-[starting-style]:opacity-0 motion-reduce:data-[starting-style]:[transform:none]',
          )}
          aria-label={label}
        >
          <Drawer.Content className="p-5 pb-[calc(1.5rem_+_env(safe-area-inset-bottom))]">
            <div className="flex items-start justify-between gap-4">
              {head}
              <Drawer.Close
                className="-mt-2 -mr-2 grid size-11 flex-none cursor-pointer place-items-center rounded-full border-0 bg-card-sunk p-0 text-ink-soft [&_svg]:size-5"
                aria-label="Close"
              >
                <XIcon aria-hidden="true" />
              </Drawer.Close>
            </div>
            {children}
          </Drawer.Content>
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal>
  </Drawer.Root>
);
