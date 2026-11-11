/**
 * Parse RESIDENTIAL_PROXY_URL for Chromium's --proxy-server argument.
 *
 * Accepted formats:
 *   host:port
 *   username:password@host:port
 *   http://username:password@host:port
 *
 * Credentials should be URL-encoded when they contain reserved URL characters.
 */
export function parseResidentialProxy(value) {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input) return null;

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("RESIDENTIAL_PROXY_URL must be host:port or username:password@host:port.");
  }

  if (url.protocol !== "http:") {
    throw new Error("RESIDENTIAL_PROXY_URL must use an HTTP proxy.");
  }
  if (!url.hostname || !url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("RESIDENTIAL_PROXY_URL must include a host and port, with no path, query, or fragment.");
  }

  let username;
  let password;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new Error("RESIDENTIAL_PROXY_URL contains invalid URL-encoded credentials.");
  }
  if ((username && !password) || (!username && password)) {
    throw new Error("RESIDENTIAL_PROXY_URL credentials must include both a username and password.");
  }

  return {
    server: `http://${url.hostname}:${url.port}`,
    ...(username ? { username, password } : {}),
  };
}
