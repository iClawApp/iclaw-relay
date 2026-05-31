/**
 * HTML shown when a subdomain's tunnel is in the "reconnecting" grace
 * window — iClaw lost its WS to the relay (network blip, process
 * restart) and we're keeping the subdomain reserved for a few minutes
 * so the same URL stays valid when it comes back.
 *
 * Mirrors the visual language of tunnelNotFoundPage. Auto-refreshes
 * every 5 seconds so the browser picks up the moment iClaw is back.
 */

export function renderReconnectingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="refresh" content="5" />
<title>Reconnecting — iClaw</title>
<link rel="icon" href="https://iclaw.digital/favicon.ico" sizes="any" />
<style>
  :root {
    color-scheme: light dark;
    --bg: #f9f9f9;
    --surface: #ffffff;
    --text: #18181b;
    --muted: #71717a;
    --border: #e4e4e7;
    --accent: #3b82f6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1a1a;
      --surface: #232323;
      --text: #ececec;
      --muted: #9ca3af;
      --border: #424242;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .header { padding: 20px 24px; }
  .brand {
    display: inline-flex; align-items: center; gap: 9px;
    font-size: 0.85rem; font-weight: 600; letter-spacing: -0.01em;
    color: var(--text); text-decoration: none;
  }
  .brand-logo { width: 24px; height: 24px; border-radius: 6px; display: block; }
  .main {
    flex: 1; display: grid; place-items: center;
    padding: 0 24px 32px;
  }
  .card { width: 100%; max-width: 22rem; }
  .spinner {
    width: 28px; height: 28px;
    border-radius: 50%;
    border: 2.2px solid color-mix(in srgb, var(--muted) 25%, transparent);
    border-top-color: var(--accent);
    margin: 0 0 14px;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 {
    margin: 0 0 12px;
    font-size: 1.3rem;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1.15;
  }
  p {
    margin: 0 0 8px;
    font-size: 0.9rem;
    line-height: 1.55;
    color: var(--muted);
  }
  .note {
    margin-top: 18px;
    font-size: 0.75rem;
    color: var(--muted);
  }
  @media (max-width: 480px) {
    .header { padding: 16px; }
    .main { padding: 0 16px 24px; }
  }
</style>
</head>
<body>
<header class="header">
  <a class="brand" href="https://iclaw.digital/" rel="noopener noreferrer">
    <img class="brand-logo" src="https://iclaw.digital/logo.png" alt="" width="24" height="24" decoding="async" />
    <span>iClaw</span>
  </a>
</header>
<main class="main">
  <div class="card">
    <div class="spinner" aria-hidden="true"></div>
    <h1>Reconnecting…</h1>
    <p>The host briefly lost its connection. This page will refresh in 5 seconds.</p>
    <p>Your link and passphrase stay the same — you don't need to ask for a new one.</p>
  </div>
</main>
</body>
</html>`;
}
