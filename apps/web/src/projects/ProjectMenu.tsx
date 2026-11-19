import { Menu } from '@base-ui/react/menu';
import { DotsThreeIcon, HeartBreakIcon } from '@phosphor-icons/react';

/** A project page's `⋯`: what its page does besides the call to action. Only Remove, for now. */
export const ProjectMenu = ({
  projectName,
  onRemove,
}: {
  readonly projectName: string;
  readonly onRemove: () => void;
}) => (
  <Menu.Root>
    <Menu.Trigger
      className="mt-[0.2em] grid size-11 flex-none cursor-pointer place-items-center rounded-full bg-white/55 text-wine transition-[background-color,scale] duration-[160ms] ease-out hover:bg-card active:scale-[0.94] data-[pressed]:bg-card motion-reduce:transition-none [&_svg]:size-6"
      aria-label={`More for ${projectName}`}
    >
      <DotsThreeIcon weight="bold" aria-hidden="true" />
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner sideOffset={8} align="end" className="outline-none">
        <Menu.Popup className="min-w-[15rem] origin-[var(--transform-origin)] rounded-[16px] bg-card p-1.5 text-ink shadow-lift outline-none transition-[opacity,scale] duration-[180ms] ease-out data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0 motion-reduce:transition-[opacity]">
          <Menu.Item
            className="flex min-h-11 cursor-pointer items-center gap-[0.6rem] rounded-[10px] px-4 py-2 text-[1rem] font-semibold text-wine outline-none select-none data-[highlighted]:bg-petal-wash data-[highlighted]:text-lipstick [&_svg]:size-5 [&_svg]:flex-none [&_svg]:text-lipstick"
            onClick={onRemove}
          >
            <HeartBreakIcon weight="fill" aria-hidden="true" />
            Remove from CodeTinder…
          </Menu.Item>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
);
