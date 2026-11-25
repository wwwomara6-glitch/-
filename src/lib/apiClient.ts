const RAW_API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '';

export const API_BASE_URL = RAW_API_BASE.replace(/\/+$/, '');

let lastWarmAttemptMs = 0;
let inflightWarmPromise: Promise<boolean> | null = null;

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (!API_BASE_URL) {
    return normalizedPath;
  }
  return `${API_BASE_URL}${normalizedPath}`;
}

/**
 * Best-effort pre-warm for Render Free web services (~15m idle spin-down).
 * Never blocks storefront load: call only when the user opens Cart, Tracking,
 * Loyalty lookup, Custom Request, or Admin Dashboard.
 */
export function warmApiServer(cooldownMs = 45_000): Promise<boolean> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return Promise.resolve(false);
  }
  const now = Date.now();
  if (inflightWarmPromise) {
    return inflightWarmPromise;
  }
  if (now - lastWarmAttemptMs < cooldownMs) {
    return Promise.resolve(true);
  }

  lastWarmAttemptMs = now;
  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer =
    controller !== null
      ? window.setTimeout(() => controller.abort(), 12_000)
      : undefined;

  inflightWarmPromise = fetch(apiUrl('/api/health'), {
    method: 'GET',
    mode: API_BASE_URL ? 'cors' : 'same-origin',
    ...(controller ? { signal: controller.signal } : {}),
  })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      inflightWarmPromise = null;
    });

  return inflightWarmPromise;
}

export function isMaintenanceResponse(
  status: number,
  body?: { code?: string; error?: string } | null
): boolean {
  return (
    status === 503 ||
    body?.code === 'MAINTENANCE_FREEZE' ||
    body?.code === 'STRICT_NO_LOCAL_WRITES'
  );
}
