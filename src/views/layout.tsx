import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';

export const Layout = ({ title = 'Shop Tracker', children }: { title?: string; children: Child }) => (
  <>
    {raw('<!doctype html>')}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{title}</title>
        {/* Lets the site be added to an iPhone or Android home screen and open full screen, like an app.
            The manifest and icons live in public/, so they load without signing in. */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/favicon-32.png" type="image/png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="theme-color" content="#a63a2b" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Shop Tracker" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="stylesheet" href="/app.css" />
      </head>
      <body>{children}</body>
    </html>
  </>
);
