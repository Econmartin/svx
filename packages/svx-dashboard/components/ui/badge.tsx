import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-mono transition-colors',
  {
    variants: {
      variant: {
        default: 'border-border bg-surface-elevated text-muted-strong',
        live: 'border-win/40 bg-win/10 text-win',
        paused: 'border-loss/40 bg-loss/10 text-loss',
        warn: 'border-warn/40 bg-warn/10 text-warn',
        outline: 'border-border-strong text-muted',
        testnet: 'border-accent/40 bg-accent/10 text-accent',
        mainnet: 'border-loss/40 bg-loss/10 text-loss',
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
