import fs from 'node:fs';
import path from 'node:path';
import {
  compareProductsByCode,
  sanitizeHref,
  sanitizeImageInput,
  type Product,
  type ProductCategory,
  type SocialLink,
  type StoreInfo,
} from '../utils/commerce.ts';

export interface FirestoreCatalogTarget {
  projectId: string;
  firestoreDatabaseId: string;
}

export interface AuthoritativeCatalog {
  version: string;
  updatedAt: string;
  storeInfo: StoreInfo;
  products: Product[];
  socialLinks: SocialLink[];
  source: 'firestore-rest' | 'cache' | 'fallback';
}

export interface FirestoreRestFetcher {
  getDocument: (docPath: string) => Promise<Record<string, unknown> | null>;
}

const VALID_CATEGORIES = new Set<ProductCategory>([
  'blaugrana',
  'other_brands',
  'body_mist',
  'room_spray',
  'deodorant',
  'hair_care',
  'tester',
]);

const CHUNK_ID_REGEX = /^chunk_[0-9]{1,3}$/;
const DEFAULT_CACHE_TTL_MS = 60_000;

export function loadDefaultFirebaseTarget(): FirestoreCatalogTarget | null {
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (!fs.existsSync(configPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      projectId?: string;
      firestoreDatabaseId?: string;
    };
    const projectId =
      process.env.FIREBASE_PROJECT_ID?.trim() || parsed.projectId?.trim() || '';
    const firestoreDatabaseId =
      process.env.FIREBASE_DATABASE_ID?.trim() ||
      parsed.firestoreDatabaseId?.trim() ||
      '(default)';
    if (!projectId) return null;
    return { projectId, firestoreDatabaseId };
  } catch {
    return null;
  }
}

export function decodeFirestoreValue(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if ('nullValue' in obj) return null;
  if ('booleanValue' in obj) return Boolean(obj.booleanValue);
  if ('stringValue' in obj) return String(obj.stringValue);
  if ('timestampValue' in obj) return String(obj.timestampValue);
  if ('integerValue' in obj) {
    const n = Number(obj.integerValue);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  if ('doubleValue' in obj) {
    const n = Number(obj.doubleValue);
    return Number.isFinite(n) ? n : 0;
  }
  if ('arrayValue' in obj) {
    const arrObj = obj.arrayValue as { values?: unknown[] } | undefined;
    return Array.isArray(arrObj?.values)
      ? arrObj.values.map((v) => decodeFirestoreValue(v))
      : [];
  }
  if ('mapValue' in obj) {
    const mapObj = obj.mapValue as { fields?: Record<string, unknown> } | undefined;
    return decodeFirestoreFields(mapObj?.fields ?? {});
  }
  return null;
}

export function decodeFirestoreFields(
  fields: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const [k, v] of Object.entries(fields)) {
    out[k] = decodeFirestoreValue(v);
  }
  return out;
}

export function createHttpFirestoreFetcher(
  target: FirestoreCatalogTarget,
  timeoutMs = 3500
): FirestoreRestFetcher {
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    target.projectId
  )}/databases/${encodeURIComponent(target.firestoreDatabaseId)}/documents`;

  return {
    async getDocument(docPath: string) {
      const cleanPath = docPath.replace(/^\/+/, '');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}/${cleanPath}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (res.status === 404) {
          return null;
        }
        if (!res.ok) {
          throw new Error(`Firestore REST HTTP ${res.status} on ${cleanPath}`);
        }
        const json = (await res.json()) as { fields?: Record<string, unknown> };
        if (!json || !json.fields) return null;
        return decodeFirestoreFields(json.fields);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function normalizeServerProduct(raw: unknown): Product | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const code = typeof r.code === 'string' ? r.code.trim() : '';
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  const brand = typeof r.brand === 'string' ? r.brand.trim() : 'بلوكرانا';
  const category = VALID_CATEGORIES.has(r.category as ProductCategory)
    ? (r.category as ProductCategory)
    : null;
  const priceIqd =
    typeof r.priceIqd === 'number' && Number.isFinite(r.priceIqd)
      ? Math.round(r.priceIqd)
      : 0;
  if (!id || !code || !name || !category || priceIqd <= 0) return null;

  let sizePrices: Record<string, number> | undefined;
  if (r.sizePrices && typeof r.sizePrices === 'object' && !Array.isArray(r.sizePrices)) {
    const cleaned: Record<string, number> = {};
    for (const [sz, val] of Object.entries(r.sizePrices as Record<string, unknown>)) {
      const num = Math.round(Number(val));
      if (sz.trim() && Number.isFinite(num) && num > 0) {
        cleaned[sz.trim()] = num;
      }
    }
    if (Object.keys(cleaned).length > 0) sizePrices = cleaned;
  }

  return {
    id,
    code,
    name,
    brand,
    category,
    priceIqd,
    size: typeof r.size === 'string' && r.size.trim() ? r.size.trim() : '100 مل',
    ...(sizePrices ? { sizePrices } : {}),
    notes: typeof r.notes === 'string' ? r.notes : '',
    ...(typeof r.topNotes === 'string' && r.topNotes.trim()
      ? { topNotes: r.topNotes.trim() }
      : {}),
    ...(typeof r.heartNotes === 'string' && r.heartNotes.trim()
      ? { heartNotes: r.heartNotes.trim() }
      : {}),
    ...(typeof r.baseNotes === 'string' && r.baseNotes.trim()
      ? { baseNotes: r.baseNotes.trim() }
      : {}),
    longevity: typeof r.longevity === 'string' ? r.longevity : '24 ساعة',
    sillage: typeof r.sillage === 'string' ? r.sillage : 'فوحان ممتاز',
    description: typeof r.description === 'string' ? r.description : '',
    imageUrl: sanitizeImageInput(r.imageUrl),
    ...(typeof r.hasCustomImage === 'boolean'
      ? { hasCustomImage: r.hasCustomImage }
      : {}),
    includesFreeTester: Boolean(r.includesFreeTester),
    inStock: Boolean(r.inStock),
  };
}

export class FirestoreCatalogReader {
  private readonly fetcher: FirestoreRestFetcher | null;
  private readonly ttlMs: number;
  private cached: AuthoritativeCatalog | null = null;
  private cachedAtMs = 0;

  constructor(options?: {
    fetcher?: FirestoreRestFetcher | null;
    target?: FirestoreCatalogTarget | null;
    ttlMs?: number;
  }) {
    if (options?.fetcher !== undefined) {
      this.fetcher = options.fetcher;
    } else {
      const target = options?.target ?? loadDefaultFirebaseTarget();
      this.fetcher = target ? createHttpFirestoreFetcher(target) : null;
    }
    this.ttlMs = options?.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  invalidateCache(): void {
    this.cached = null;
    this.cachedAtMs = 0;
  }

  async getAuthoritativeCatalog(options?: {
    forceRefresh?: boolean;
    nowMs?: number;
    fallbackCatalog?: () => Promise<Omit<AuthoritativeCatalog, 'source'>> | Omit<AuthoritativeCatalog, 'source'>;
  }): Promise<AuthoritativeCatalog | null> {
    const nowMs = options?.nowMs ?? Date.now();
    if (
      !options?.forceRefresh &&
      this.cached &&
      nowMs - this.cachedAtMs < this.ttlMs
    ) {
      return { ...this.cached, source: 'cache' };
    }

    if (this.fetcher) {
      try {
        const meta = await this.fetcher.getDocument('catalog_meta/public');
        if (meta && typeof meta.version === 'string' && Array.isArray(meta.chunkIds)) {
          const version = meta.version.trim();
          const chunkIds = meta.chunkIds.filter(
            (id): id is string => typeof id === 'string' && CHUNK_ID_REGEX.test(id.trim())
          );

          if (
            !options?.forceRefresh &&
            this.cached &&
            this.cached.version === version &&
            this.cached.products.length > 0
          ) {
            this.cached = {
              ...this.cached,
              storeInfo: (meta.storeInfo as StoreInfo) ?? this.cached.storeInfo,
              socialLinks: Array.isArray(meta.socialLinks)
                ? (meta.socialLinks as SocialLink[]).map((s) => ({
                    ...s,
                    url: sanitizeHref(s.url),
                  }))
                : this.cached.socialLinks,
              updatedAt:
                typeof meta.updatedAt === 'string'
                  ? meta.updatedAt
                  : this.cached.updatedAt,
            };
            this.cachedAtMs = nowMs;
            return { ...this.cached, source: 'cache' };
          }

          if (chunkIds.length > 0) {
            const chunks = await Promise.all(
              chunkIds.map((cid) => this.fetcher!.getDocument(`catalog_chunks/${cid}`))
            );
            const productsById = new Map<string, Product>();
            let chunksOk = true;
            for (const ch of chunks) {
              if (
                !ch ||
                ch.version !== version ||
                !Array.isArray(ch.items)
              ) {
                chunksOk = false;
                break;
              }
              for (const item of ch.items) {
                const p = normalizeServerProduct(item);
                if (p) productsById.set(p.id, p);
              }
            }

            const expectedCount =
              typeof meta.productCount === 'number' ? meta.productCount : 0;
            if (
              chunksOk &&
              productsById.size > 0 &&
              productsById.size >= expectedCount
            ) {
              const snapshot: AuthoritativeCatalog = {
                version,
                updatedAt:
                  typeof meta.updatedAt === 'string'
                    ? meta.updatedAt
                    : new Date(nowMs).toISOString(),
                storeInfo: meta.storeInfo as StoreInfo,
                products: Array.from(productsById.values()).sort(compareProductsByCode),
                socialLinks: Array.isArray(meta.socialLinks)
                  ? (meta.socialLinks as SocialLink[]).map((s) => ({
                      ...s,
                      url: sanitizeHref(s.url),
                    }))
                  : [],
                source: 'firestore-rest',
              };
              this.cached = snapshot;
              this.cachedAtMs = nowMs;
              return snapshot;
            }
          }
        }
      } catch {
        if (this.cached && this.cached.products.length > 0) {
          return { ...this.cached, source: 'cache' };
        }
      }
    }

    if (options?.fallbackCatalog) {
      const fb = await options.fallbackCatalog();
      return { ...fb, source: 'fallback' };
    }

    return null;
  }
}
