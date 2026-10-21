import type { Metadata, Viewport } from 'next';
import { Toaster } from '@/components/feedback/toast';
import { ThemeProvider } from '@/components/theme/theme';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'EnvVault — Secrets & environment management',
    template: '%s · EnvVault',
  },
  description:
    'EnvVault is a centralized platform for managing environment variables and secrets across projects, environments and teams.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fcfcfd' },
    { media: '(prefers-color-scheme: dark)', color: '#111214' },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // next-themes sets the theme class on <html> before hydration.
    <html lang="en" suppressHydrationWarning>
      {/* Browser extensions (for example ColorZilla) add attributes to <body> before hydration. */}
      <body suppressHydrationWarning>
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
