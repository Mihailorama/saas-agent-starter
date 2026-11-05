import type { ComponentProps } from 'react';
import { Toaster as Sonner } from 'sonner';
import { useTheme } from '@/lib/theme';

export function Toaster(props: ComponentProps<typeof Sonner>) {
  return (
    <Sonner
      theme={useTheme()}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  );
}
