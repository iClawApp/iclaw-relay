/**
 * HTML shown when a subdomain has no active tunnel on this relay.
 * Self-contained (inline CSS) — subdomain traffic never reaches iClaw static.
 */

export function renderTunnelNotFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Link unavailable — iClaw</title>
<link rel="icon" href="https://iclaw.digital/favicon.ico" sizes="any" />
<style>
  :root {
    color-scheme: light dark;
    --bg: #f9f9f9;
    --surface: #ffffff;
    --text: #18181b;
    --muted: #71717a;
    --border: #e4e4e7;
    --btn-bg: #18181b;
    --btn-fg: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1a1a;
      --surface: #232323;
      --text: #ececec;
      --muted: #9ca3af;
      --border: #424242;
      --btn-bg: #ececec;
      --btn-fg: #18181b;
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
  .header {
    padding: 20px 24px;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
    text-decoration: none;
  }
  .brand-logo {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: block;
  }
  .main {
    flex: 1;
    display: grid;
    place-items: center;
    padding: 0 24px 32px;
  }
  .card {
    width: 100%;
    max-width: 22rem;
  }
  .symbol {
    width: 28px;
    height: 28px;
    color: var(--muted);
    opacity: 0.8;
    margin-bottom: 12px;
  }
  h1 {
    margin: 0 0 16px;
    font-size: 1.35rem;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1.15;
  }
  .tips {
    margin: 0 0 20px;
    padding-left: 1.15em;
    font-size: 0.85rem;
    line-height: 1.55;
    color: var(--muted);
  }
  .tips li + li { margin-top: 6px; }
  .tips strong {
    font-weight: 600;
    color: var(--text);
  }
  .note {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.5;
    text-align: center;
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
    <svg class="symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      <line x1="4" y1="4" x2="20" y2="20"/>
    </svg>
    <h1>This link isn’t available</h1>
    <ul class="tips">
      <li>The host may be offline or Remote Access was turned off</li>
      <li>The link may have expired — ask for a new one from <strong>Settings → Remote Access</strong></li>
      <li>Use the full URL you were given, including the subdomain</li>
    </ul>
    <p class="note">Served by iclaw relay — your request did not reach a local iClaw instance</p>
  </div>
</main>
</body>
</html>`;
}
