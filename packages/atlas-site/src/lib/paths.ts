/**
 * Prefix an absolute site path with Astro's configured base URL.
 */
export function withBase(path: string, baseUrl: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (base === "" || base === "/") {
    return normalizedPath;
  }
  return `${base}${normalizedPath}`;
}
