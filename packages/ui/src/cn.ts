import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names, the later winning where two Tailwind utilities set the same thing. */
export const cn = (...inputs: readonly ClassValue[]): string => twMerge(clsx(inputs));
