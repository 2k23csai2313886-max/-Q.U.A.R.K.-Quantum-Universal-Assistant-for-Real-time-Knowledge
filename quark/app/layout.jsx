import './globals.css';
import { APP } from '@/lib/constants';

export const metadata = {
  title: `${APP.name} — ${APP.expanded}`,
  description:
    'A voice-and-text HUD personal assistant built with Next.js, React 19 and Gemini function calling. ' +
    'Opens websites, searches the web, reads device sensors, captures camera and screen, manages files, timers and reminders.',
  applicationName: APP.name,
  keywords: ['AI assistant', 'JARVIS', 'HUD', 'Next.js', 'React', 'Gemini', 'function calling', 'voice assistant'],
  authors: [{ name: `Team ${APP.teamId}`, url: 'https://github.com/raghavkashyap-org' }],
  creator: APP.teamId,
  icons: { icon: '/favicon.svg' },
  openGraph: {
    title: `${APP.name} — ${APP.expanded}`,
    description: 'Agentic HUD assistant · Next.js 16 · React 19 · Gemini function calling',
    type: 'website',
    siteName: APP.name,
  },
  // Required so Web Speech API, camera and geolocation work at all.
  other: { 'theme-color': '#08050f' },
};

export const viewport = {
  themeColor: '#08050f',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
