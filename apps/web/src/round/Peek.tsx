import { Popover } from '@base-ui/react/popover';
import { cn } from '@codetinder/ui';
import { type ReactElement, type ReactNode, useRef, useState } from 'react';
import { Sheet } from '../components/ui/Sheet';

/** How long a mouse rests on a trigger before its peek shows, and lingers after leaving. */
const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 200;

export const isTouch = (pointerType: string) => pointerType === 'touch' || pointerType === 'pen';

export type PeekState = {
  readonly isOpen: boolean;
  readonly isPinned: boolean;
};

export const INITIAL_PEEK_STATE: PeekState = { isOpen: false, isPinned: false };

/**
 * How a desktop peek's open state moves on a Base UI `onOpenChange`: a click pins a peek that a
 * hover opened (and closes one it pinned), and a hover-leave never closes a pinned peek.
 */
export const nextPeekState = (
  state: PeekState,
  { next, reason }: { readonly next: boolean; readonly reason: string },
): PeekState => {
  if (reason === 'trigger-press') {
    const isPinned = next || !state.isPinned;
    return { isOpen: isPinned, isPinned };
  }
  if (!next && reason === 'trigger-hover' && state.isPinned) return state;
  return { isOpen: next, isPinned: next ? state.isPinned : false };
};

/**
 * A card's peek: resting the mouse on `trigger` shows a popover beside it, and a click (or Enter)
 * pins it open; a tap on touch opens a sheet from the bottom instead, where there is no hover.
 */
export const Peek = ({
  trigger,
  isNativeButton = true,
  align = 'start',
  alignOffset,
  sideOffset = 8,
  label,
  head,
  children,
  sheetChildren = children,
}: {
  readonly trigger: ReactElement;
  readonly isNativeButton?: boolean;
  readonly align?: 'start' | 'end';
  readonly alignOffset?: number;
  readonly sideOffset?: number;
  readonly label: string;
  readonly head: ReactNode;
  readonly children: ReactNode;
  readonly sheetChildren?: ReactNode;
}) => {
  const [peek, setPeek] = useState(INITIAL_PEEK_STATE);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  // Read from the press, not the click: not every browser says which pointer made a click.
  const pressedWith = useRef('');

  return (
    <>
      <Popover.Root
        open={peek.isOpen}
        onOpenChange={(next, { reason }) => {
          setPeek(current => nextPeekState(current, { next, reason }));
        }}
      >
        <Popover.Trigger
          render={trigger}
          nativeButton={isNativeButton}
          openOnHover
          delay={OPEN_DELAY_MS}
          closeDelay={CLOSE_DELAY_MS}
          onPointerDown={event => {
            pressedWith.current = event.pointerType;
          }}
          onClick={event => {
            const isTap = isTouch(pressedWith.current);
            pressedWith.current = '';
            if (!isTap) return;
            event.preventBaseUIHandler();
            setIsSheetOpen(true);
          }}
        />
        <Popover.Portal>
          <Popover.Positioner
            side="bottom"
            align={align}
            alignOffset={alignOffset}
            sideOffset={sideOffset}
          >
            <Popover.Popup
              className={cn(
                'w-max max-h-[min(26rem,var(--available-height))] max-w-[min(36rem,calc(100vw_-_2rem))] overflow-auto rounded-[12px] bg-card px-[1.15rem] py-4 text-[1rem] text-ink shadow-lift outline-none',
                'origin-[var(--transform-origin)] [transition:opacity_180ms_var(--ease-out),transform_260ms_var(--ease-spring)]',
                'data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[ending-style]:[transform:scale(0.96)] data-[starting-style]:[transform:scale(0.96)]',
                'motion-reduce:data-[ending-style]:[transform:none] motion-reduce:data-[starting-style]:[transform:none]',
              )}
              aria-label={label}
            >
              {head}
              {children}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen} label={label} head={head}>
        {sheetChildren}
      </Sheet>
    </>
  );
};
