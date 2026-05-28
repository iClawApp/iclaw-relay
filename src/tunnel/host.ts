/**
 * Shared helper: extract the per-tunnel subdomain from the request's Host
 * header. Returns null when the host doesn't sit under the configured
 * base domain (or when the subdomain is nested / empty).
 *
 * Used by both the HTTP catch-all proxy and the WS upgrade router so they
 * stay in lockstep on which hosts are tunnel-routed.
 */

export function extractSubdomain(
  hostHeader: string | undefined,
  baseDomain: string,
): string | null {
  if (!hostHeader) return null;
  // Strip port if present.
  const host = hostHeader.split(':')[0].toLowerCase();
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const sub = host.slice(0, -suffix.length);
  // Reject empty / nested subdomains for now.
  if (!sub || sub.includes('.')) return null;
  return sub;
}
