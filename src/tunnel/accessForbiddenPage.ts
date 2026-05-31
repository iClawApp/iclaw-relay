/** Minimal 403 when relay access token is missing or invalid. */
export function renderAccessForbiddenPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Access denied — iClaw</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #f4f4f5;
    color: #18181b;
  }
  .card { max-width: 22rem; padding: 0 24px; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 12px; }
  p { margin: 0; font-size: 0.9rem; line-height: 1.5; color: #71717a; }
</style>
</head>
<body>
  <div class="card">
    <h1>Access denied</h1>
    <p>This link requires a valid access token. Open the full URL shared from iClaw Settings.</p>
  </div>
</body>
</html>`;
}
