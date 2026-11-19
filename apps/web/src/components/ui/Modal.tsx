import { Dialog } from '@base-ui/react/dialog';
import { cn } from '@codetinder/ui';
import { XIcon } from '@phosphor-icons/react';
import { type ReactNode, type RefObject, useRef } from 'react';

/**
 * The site's modal: a card over a wine scrim on desktop, a bottom sheet on phones. Escape, a press
 * outside and the close button all close it, except while `isBusy`, so a change to GitLab is never
 * cut off halfway. `onClosed` runs once its exit animation ends, when the caller can unmount it.
 */
export const Modal = ({
  open,
  onOpenChange,
  onClosed,
  title,
  label,
  isBusy = false,
  initialFocus,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onClosed?: () => void;
  /** Shown as the modal's heading; without one, `label` names it. */
  readonly title?: string;
  readonly label?: string;
  readonly isBusy?: boolean;
  /** What takes focus on opening; by default the modal itself, so its title is read first. */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}) => {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={next => {
        if (next || !isBusy) onOpenChange(next);
      }}
      onOpenChangeComplete={isOpen => {
        if (!isOpen) onClosed?.();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 min-h-dvh bg-[rgb(74_6_26/0.4)] transition-opacity duration-[260ms] ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 grid place-items-center p-4 max-sm:items-end max-sm:justify-items-stretch max-sm:p-0">
          <Dialog.Popup
            className={cn(
              // A card floating over the page on desktop; phones get a bottom sheet (below).
              'flex max-h-[min(44rem,calc(100dvh_-_2rem))] w-[min(38rem,100%)] flex-col rounded-[2rem] bg-card text-ink shadow-lift outline-0 focus-visible:outline-none',
              '[transition:opacity_260ms_var(--ease-out),transform_360ms_var(--ease-out)] data-[ending-style]:opacity-0 data-[ending-style]:[transform:translateY(1rem)_scale(0.97)] data-[starting-style]:opacity-0 data-[starting-style]:[transform:translateY(1rem)_scale(0.97)]',
              // The sheet runs to the screen's bottom edge; its content stays clear of the gesture bar.
              'max-sm:max-h-[88dvh] max-sm:w-full max-sm:rounded-[1.25rem_1.25rem_0_0] max-sm:pb-[env(safe-area-inset-bottom)] max-sm:duration-[320ms] max-sm:data-[ending-style]:opacity-100 max-sm:data-[starting-style]:opacity-100',
              // The sheet's slide is motion-safe only, so reduced motion's `transform: none` holds on phones too.
              'max-sm:motion-safe:data-[ending-style]:[transform:translateY(100%)] max-sm:motion-safe:data-[starting-style]:[transform:translateY(100%)]',
              'motion-reduce:data-[ending-style]:[transform:none] motion-reduce:data-[starting-style]:[transform:none]',
            )}
            aria-label={title ? undefined : label}
            aria-busy={isBusy}
            ref={popupRef}
            initialFocus={initialFocus ?? popupRef}
          >
            <div className="flex flex-none items-start justify-between gap-4 pt-6 pr-6 pl-7 max-sm:p-5 max-sm:pb-0">
              {title && (
                <Dialog.Title className="font-display text-[clamp(1.5rem,1.2rem_+_0.9vw,2rem)] leading-[1.1] font-bold text-balance text-candy-red text-shadow-emboss">
                  {title}
                </Dialog.Title>
              )}
              <Dialog.Close
                className="ml-auto grid size-11 flex-none cursor-pointer place-items-center rounded-full border-0 bg-card-sunk p-0 text-ink-soft transition-[background-color] duration-[160ms] ease-out not-data-[disabled]:hover:bg-petal-soft not-data-[disabled]:hover:text-wine data-[disabled]:cursor-default data-[disabled]:opacity-40 [&_svg]:size-5"
                aria-label="Close"
                disabled={isBusy}
              >
                <XIcon aria-hidden="true" />
              </Dialog.Close>
            </div>
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
