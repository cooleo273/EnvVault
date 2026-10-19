'use client';

import { useTheme } from 'next-themes';
import { toast as sonnerToast, Toaster as SonnerToaster } from 'sonner';

/**
 * Toast foundation. Render <Toaster /> once (root layout) and call `notify`
 * from client code. Messages are announced through an aria-live region.
 *
 * Never put secret values, tokens or raw server error messages in a toast.
 */
export function Toaster() {
  const { resolvedTheme } = useTheme();
  return (
    <SonnerToaster
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      position="bottom-right"
      closeButton
      duration={5000}
      toastOptions={{
        classNames: {
          toast:
            'border! border-border! bg-popover! text-popover-foreground! shadow-popover! rounded-lg! text-sm!',
          description: 'text-muted-foreground!',
          closeButton: 'border-border! bg-popover! text-muted-foreground!',
        },
      }}
    />
  );
}

export interface NotifyOptions {
  description?: string;
}

export const notify = {
  success: (message: string, options?: NotifyOptions) => sonnerToast.success(message, options),
  error: (message: string, options?: NotifyOptions) => sonnerToast.error(message, options),
  info: (message: string, options?: NotifyOptions) => sonnerToast.info(message, options),
  warning: (message: string, options?: NotifyOptions) => sonnerToast.warning(message, options),
};
