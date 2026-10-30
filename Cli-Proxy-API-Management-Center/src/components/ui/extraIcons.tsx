import type { SVGProps } from 'react';
import type { IconProps } from './icons';

// Icons this fork adds, in the same Lucide style as icons.tsx, kept apart so syncs don't conflict.

const baseSvgProps: SVGProps<SVGSVGElement> = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  focusable: 'false',
};

export function IconChartColumn({ size = 20, ...props }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} {...props}>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </svg>
  );
}
