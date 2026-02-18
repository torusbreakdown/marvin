// SECURITY: Centralized SSRF protection for all outbound HTTP requests.
// Validates URLs against private/internal network ranges.

/**
 * Check if a URL points to a private/internal address.
 * Returns an error string if blocked, null if allowed.
 */
export function isPrivateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Error: Invalid URL: ${url}`;
  }

  // Only allow http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Error: Only http:// and https:// URLs are allowed. Got: ${parsed.protocol}`;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and loopback
  if (hostname === 'localhost' || hostname === '0.0.0.0') {
    return `Error: Access to localhost/loopback addresses is not allowed.`;
  }

  // Block IPv6 loopback [::1] — URL parser strips brackets from hostname
  if (hostname === '::1' || hostname === '[::1]') {
    return `Error: Access to localhost/loopback addresses is not allowed.`;
  }

  // Block IPv4 loopback range 127.x.x.x
  if (hostname.match(/^127\.\d+\.\d+\.\d+$/)) {
    return `Error: Access to loopback addresses is not allowed.`;
  }

  // Block IPv6-mapped IPv4 loopback [::ffff:127.x.x.x]
  if (hostname.match(/^::ffff:127\.\d+\.\d+\.\d+$/) || hostname.match(/^::ffff:7f/i)) {
    return `Error: Access to loopback addresses is not allowed.`;
  }

  // Block hex IP representations (0x7f000001 = 127.0.0.1)
  if (hostname.match(/^0x[0-9a-f]+$/i)) {
    return `Error: Access to hex IP addresses is not allowed.`;
  }

  // Block decimal IP representations (2130706433 = 127.0.0.1)
  if (hostname.match(/^\d+$/) && !hostname.includes('.')) {
    return `Error: Access to decimal IP addresses is not allowed.`;
  }

  // Block octal IP representations (0177.0.0.1 = 127.0.0.1)
  if (hostname.match(/^0\d+\./)) {
    return `Error: Access to octal IP addresses is not allowed.`;
  }

  // Block link-local (AWS metadata, Azure IMDS, etc.)
  if (hostname === '169.254.169.254' || hostname.startsWith('169.254.')) {
    return `Error: Access to link-local/metadata addresses is not allowed.`;
  }

  // Block common private network ranges
  if (hostname.startsWith('10.') || hostname.startsWith('192.168.') ||
      hostname.match(/^172\.(1[6-9]|2\d|3[01])\./) ||
      hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return `Error: Access to private network addresses is not allowed.`;
  }

  // Block IPv6 private ranges
  // fe80:: link-local, fc00::/fd00:: unique local, ::1 loopback
  if (hostname.startsWith('fe80:') || hostname.startsWith('fc00:') ||
      hostname.startsWith('fd00:') || hostname.startsWith('fd') ||
      hostname === '::' || hostname.startsWith('::ffff:10.') ||
      hostname.startsWith('::ffff:192.168.') ||
      hostname.match(/^::ffff:172\.(1[6-9]|2\d|3[01])\./)) {
    return `Error: Access to private/link-local IPv6 addresses is not allowed.`;
  }

  return null;
}
