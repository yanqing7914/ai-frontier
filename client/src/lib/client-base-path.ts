function normalizeBasePath(value: string): string {
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash || '/';
}

export function resolveClientBasePath(
  injectedBasePath: string | undefined,
  pathname: string,
): string {
  const injected = normalizeBasePath(injectedBasePath || '/');
  const appPath = pathname.match(/^\/app\/[^/]+/)?.[0];

  // Embedded preview can inject the generic /app/ prefix while serving the
  // document at either the app path or the runtime root.
  if (appPath && (injected === '/' || injected === '/app')) {
    return appPath;
  }

  if (injected === '/app' && !pathname.startsWith('/app/')) {
    return '/';
  }

  if (
    injected === '/' ||
    pathname === injected ||
    pathname.startsWith(`${injected}/`)
  ) {
    return injected;
  }

  return appPath ?? injected;
}
