import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 min-h-6 py-0.5 text-[12px] font-medium tracking-[-0.005em] transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-white/[0.06] text-muted-strong',
        live: 'border-transparent bg-win/[0.12] text-win',
        paused: 'border-transparent bg-loss/[0.12] text-loss',
        warn: 'border-transparent bg-warn/[0.12] text-warn',
        outline: 'border-border-strong text-muted',
        testnet: 'border-transparent bg-accent/[0.12] text-accent',
        mainnet: 'border-transparent bg-loss/[0.12] text-loss',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
