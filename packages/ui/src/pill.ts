import { cva } from 'class-variance-authority';

/**
 * The Lipstick pill: every primary action, on a `<button>`, an `<a>` or a `Link`. A size from the
 * recipe, or the caller's own padding and font size through `cn`.
 */
export const pillVariants = cva(
  [
    'inline-flex cursor-pointer items-center gap-[0.5em] rounded-pill bg-lipstick font-bold text-white no-underline shadow-button',
    '[transition:scale_200ms_var(--ease-spring),background-color_160ms_var(--ease-out)]',
    'not-disabled:hover:scale-[1.03] not-disabled:hover:bg-lipstick-hover not-disabled:active:scale-[0.97]',
    'disabled:cursor-default disabled:bg-petal disabled:shadow-none',
    '[&_svg]:size-[1em] [&_svg]:flex-none',
  ],
  {
    variants: {
      size: {
        sm: 'px-6 py-[0.7rem] text-[1.05rem]',
        md: 'px-7 py-[0.9rem] text-[1.1rem]',
        lg: 'px-11 py-4 text-[1.15rem]',
      },
    },
  },
);
