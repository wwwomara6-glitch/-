import { doc, getDocFromServer, type DocumentSnapshot } from 'firebase/firestore';
import { auth, db, OperationType, type FirestoreErrorInfo } from './firebase';
import {
  compareProductsByCode,
  sanitizeHref,
  sanitizeImageInput,
  type Product,
  type ProductCategory,
  type SocialLink,
  type StoreInfo,
} from '../utils/commerce';

export const CATALOG_META_COLLECTION = 'catalog_meta';
export const CATALOG_META_DOC_ID = 'public';
export const CATALOG_CHUNKS_COLLECTION = 'catalog_chunks';

export const CATALOG_CACHE_STORAGE_KEY = 'bg_firestore_catalog_cache_v1';
export const EMPTY_CATALOG_BACKOFF_STORAGE_KEY = 'bg_firestore_catalog_empty_until_v1';

/**
 * Freshness window (TTL) before revalidating `catalog_meta/public` from Firestore:
 * - Within 15 minutes: 0 Firestore reads (served directly from Memory / localStorage).
 * - After 15 minutes: 1 Firestore read (`catalog_meta/public` only) to check `version`.
 *   - If `version` matches cache: 0 chunk reads (total = 1 read).
 *   - If `version` changed: reads chunks listed in `chunkIds` (total = 1 + N reads, e.g. 3 reads for 229 products).
 */
export const DEFAULT_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Short negative-cache backoff when `catalog_meta/public` does not exist yet
 * (e.g. before Stage 4 data migration), avoiding wasted server reads on refreshes.
 */
export const DEFAULT_EMPTY_BACKOFF_MS = 5 * 60 * 1000;

export const DEFAULT_CATALOG_TIMEOUT_MS = 2500;

const VERSION_PATTERN = /^[a-zA-Z0-9_\-.]{1,64}$/;
const CHUNK_ID_PATTERN = /^chunk_[0-9]{1,3}$/;

const VALID_CATEGORIES = new Set<ProductCategory>([
  'blaugrana',
  'other_brands',
  'body_mist',
  'room_spray',
  'deodorant',
  'hair_care',
  'tester',
]);

export interface CatalogMetaDoc {
  version: string;
  productCount: number;
  chunkIds: string[];
  storeInfo: StoreInfo;
  socialLinks: SocialLink[];
  updatedAt: string;
}

export interface CatalogChunkDoc {
  chunkIndex: number;
  version: string;
  items: Product[];
  updatedAt: string;
}

export interface CatalogSnapshot {
  version: string;
  chunkIds: string[];
  storeInfo: StoreInfo;
  products: Product[];
  socialLinks: SocialLink[];
  updatedAt: string;
}

export interface CachedCatalogEnvelope {
  schemaVersion: 1;
  cachedAtMs: number;
  expiresAtMs: number;
  snapshot: CatalogSnapshot;
}

export type CatalogLoadSource =
  | 'memory-cache'
  | 'storage-cache'
  | 'firestore-meta-revalidated'
  | 'firestore-full-sync'
  | 'none';

export type CatalogFailureReason = 'empty' | 'incomplete' | 'invalid' | 'error';

export interface CatalogLoadResult {
  ok: boolean;
  source: CatalogLoadSource;
  snapshot: CatalogSnapshot | null;
  readsUsed: number;
  fallbackToLegacy: boolean;
  reason?: CatalogFailureReason;
  errorInfo?: FirestoreErrorInfo;
}

export interface DocReader {
  getDocFromServer: (collectionName: string, docId: string) => Promise<{
    exists: () => boolean;
    data: () => unknown;
  }>;
}

export interface StorageAdapter {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface LoadCatalogOptions {
  ttlMs?: number;
  emptyBackoffMs?: number;
  timeoutMs?: number;
  forceRefresh?: boolean;
  bypassEmptyBackoff?: boolean;
  revalidateOnColdPageLoad?: boolean;
  nowMs?: number;
  docReader?: DocReader;
  storage?: StorageAdapter | null;
  sessionStorageAdapter?: StorageAdapter | null;
}

let inMemoryEnvelope: CachedCatalogEnvelope | null = null;
let inMemoryEmptyUntilMs = 0;

function getBrowserLocalStorage(): StorageAdapter | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore restricted storage access
  }
  return null;
}

function getBrowserSessionStorage(): StorageAdapter | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // Ignore restricted storage access
  }
  return null;
}

const defaultDocReader: DocReader = {
  async getDocFromServer(collectionName: string, docId: string) {
    const snap: DocumentSnapshot = await getDocFromServer(
      doc(db, collectionName, docId)
    );
    return {
      exists: () => snap.exists(),
      data: () => snap.data(),
    };
  },
};

function buildFirestoreErrorInfo(
  error: unknown,
  operationType: OperationType,
  path: string
): FirestoreErrorInfo {
  const currentUser = auth.currentUser;
  return {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    authInfo: {
      userId: currentUser?.uid ?? null,
      email: currentUser?.email ?? null,
      emailVerified: currentUser?.emailVerified ?? null,
      isAnonymous: currentUser?.isAnonymous ?? null,
      tenantId: currentUser?.tenantId ?? null,
      providerInfo:
        currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) ?? [],
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Firestore catalog timeout after ${timeoutMs}ms (${label})`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStoreInfo(raw: unknown): StoreInfo | null {
  if (!isPlainRecord(raw)) return null;
  const agencyName = typeof raw.agencyName === 'string' ? raw.agencyName.trim() : '';
  const locationText = typeof raw.locationText === 'string' ? raw.locationText.trim() : '';
  const city = typeof raw.city === 'string' ? raw.city.trim() : '';
  const guaranteeTitle = typeof raw.guaranteeTitle === 'string' ? raw.guaranteeTitle.trim() : '';
  const guaranteeText = typeof raw.guaranteeText === 'string' ? raw.guaranteeText.trim() : '';
  const freeDeliveryThresholdIqd =
    typeof raw.freeDeliveryThresholdIqd === 'number' && Number.isFinite(raw.freeDeliveryThresholdIqd)
      ? Math.max(0, Math.round(raw.freeDeliveryThresholdIqd))
      : -1;
  const standardDeliveryFeeIqd =
    typeof raw.standardDeliveryFeeIqd === 'number' && Number.isFinite(raw.standardDeliveryFeeIqd)
      ? Math.max(0, Math.round(raw.standardDeliveryFeeIqd))
      : -1;

  if (
    !agencyName ||
    !locationText ||
    !city ||
    !guaranteeTitle ||
    !guaranteeText ||
    freeDeliveryThresholdIqd < 0 ||
    standardDeliveryFeeIqd < 0
  ) {
    return null;
  }

  return {
    agencyName,
    locationText,
    city,
    freeDeliveryThresholdIqd,
    standardDeliveryFeeIqd,
    guaranteeTitle,
    guaranteeText,
  };
}

function normalizeSocialLinks(raw: unknown): SocialLink[] {
  if (!Array.isArray(raw)) return [];
  const links: SocialLink[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const platform = typeof item.platform === 'string' ? item.platform.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const handle = typeof item.handle === 'string' ? item.handle.trim() : '';
    const url = typeof item.url === 'string' ? sanitizeHref(item.url) : '#';
    if (!id || !platform || !label) continue;
    links.push({ id, platform, label, handle, url });
  }
  return links;
}

function normalizeProduct(raw: unknown): Product | null {
  if (!isPlainRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const code = typeof raw.code === 'string' ? raw.code.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const brand = typeof raw.brand === 'string' ? raw.brand.trim() : '';
  const category = raw.category as ProductCategory;
  const priceIqd =
    typeof raw.priceIqd === 'number' && Number.isFinite(raw.priceIqd)
      ? Math.round(raw.priceIqd)
      : 0;
  const size = typeof raw.size === 'string' ? raw.size.trim() : '';
  const notes = typeof raw.notes === 'string' ? raw.notes.trim() : '';
  const longevity = typeof raw.longevity === 'string' ? raw.longevity.trim() : '';
  const sillage = typeof raw.sillage === 'string' ? raw.sillage.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const imageUrl = sanitizeImageInput(raw.imageUrl);

  if (
    !id ||
    !code ||
    !name ||
    !brand ||
    !VALID_CATEGORIES.has(category) ||
    priceIqd <= 0 ||
    !size ||
    !notes ||
    !longevity ||
    !sillage ||
    !description
  ) {
    return null;
  }

  let sizePrices: Record<string, number> | undefined;
  if (isPlainRecord(raw.sizePrices)) {
    const cleaned: Record<string, number> = {};
    for (const [sizeKey, val] of Object.entries(raw.sizePrices)) {
      const trimmedKey = sizeKey.trim();
      if (trimmedKey && typeof val === 'number' && Number.isFinite(val) && val > 0) {
        cleaned[trimmedKey] = Math.round(val);
      }
    }
    if (Object.keys(cleaned).length > 0) {
      sizePrices = cleaned;
    }
  }

  return {
    id,
    code,
    name,
    brand,
    category,
    priceIqd,
    size,
    ...(sizePrices ? { sizePrices } : {}),
    notes,
    ...(typeof raw.topNotes === 'string' && raw.topNotes.trim()
      ? { topNotes: raw.topNotes.trim() }
      : {}),
    ...(typeof raw.heartNotes === 'string' && raw.heartNotes.trim()
      ? { heartNotes: raw.heartNotes.trim() }
      : {}),
    ...(typeof raw.baseNotes === 'string' && raw.baseNotes.trim()
      ? { baseNotes: raw.baseNotes.trim() }
      : {}),
    longevity,
    sillage,
    description,
    imageUrl,
    ...(typeof raw.hasCustomImage === 'boolean'
      ? { hasCustomImage: raw.hasCustomImage }
      : {}),
    includesFreeTester: Boolean(raw.includesFreeTester),
    inStock: Boolean(raw.inStock),
  };
}

function parseCatalogMetaDoc(raw: unknown): CatalogMetaDoc | null {
  if (!isPlainRecord(raw)) return null;
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!VERSION_PATTERN.test(version)) return null;

  const productCount =
    typeof raw.productCount === 'number' &&
    Number.isInteger(raw.productCount) &&
    raw.productCount >= 0 &&
    raw.productCount <= 5000
      ? raw.productCount
      : -1;
  if (productCount < 0) return null;

  if (!Array.isArray(raw.chunkIds) || raw.chunkIds.length > 30) return null;
  const chunkIds: string[] = [];
  for (const cid of raw.chunkIds) {
    if (typeof cid !== 'string' || !CHUNK_ID_PATTERN.test(cid.trim())) {
      return null;
    }
    chunkIds.push(cid.trim());
  }

  const storeInfo = normalizeStoreInfo(raw.storeInfo);
  if (!storeInfo) return null;

  const socialLinks = normalizeSocialLinks(raw.socialLinks);
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt.trim() : '';
  if (!updatedAt) return null;

  return {
    version,
    productCount,
    chunkIds,
    storeInfo,
    socialLinks,
    updatedAt,
  };
}

function parseCatalogChunkDoc(raw: unknown, expectedVersion: string): CatalogChunkDoc | null {
  if (!isPlainRecord(raw)) return null;
  const chunkIndex =
    typeof raw.chunkIndex === 'number' && Number.isInteger(raw.chunkIndex) && raw.chunkIndex >= 0
      ? raw.chunkIndex
      : -1;
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt.trim() : '';
  if (chunkIndex < 0 || version !== expectedVersion || !updatedAt || !Array.isArray(raw.items)) {
    return null;
  }

  const items: Product[] = [];
  for (const item of raw.items) {
    const product = normalizeProduct(item);
    if (product) items.push(product);
  }

  return {
    chunkIndex,
    version,
    items,
    updatedAt,
  };
}

function isValidCachedEnvelope(value: unknown): value is CachedCatalogEnvelope {
  if (!isPlainRecord(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (
    typeof value.cachedAtMs !== 'number' ||
    !Number.isFinite(value.cachedAtMs) ||
    typeof value.expiresAtMs !== 'number' ||
    !Number.isFinite(value.expiresAtMs)
  ) {
    return false;
  }
  if (!isPlainRecord(value.snapshot)) return false;
  const snap = value.snapshot;
  if (typeof snap.version !== 'string' || !VERSION_PATTERN.test(snap.version)) return false;
  if (!Array.isArray(snap.chunkIds) || !Array.isArray(snap.products)) return false;
  if (snap.products.length === 0) return false;
  if (!normalizeStoreInfo(snap.storeInfo)) return false;
  return true;
}

function readCachedEnvelope(storage: StorageAdapter | null): {
  envelope: CachedCatalogEnvelope | null;
  from: 'memory-cache' | 'storage-cache' | null;
} {
  if (inMemoryEnvelope && isValidCachedEnvelope(inMemoryEnvelope)) {
    return { envelope: inMemoryEnvelope, from: 'memory-cache' };
  }
  if (!storage) {
    return { envelope: null, from: null };
  }
  try {
    const raw = storage.getItem(CATALOG_CACHE_STORAGE_KEY);
    if (!raw) return { envelope: null, from: null };
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidCachedEnvelope(parsed)) {
      storage.removeItem(CATALOG_CACHE_STORAGE_KEY);
      return { envelope: null, from: null };
    }
    inMemoryEnvelope = parsed;
    return { envelope: parsed, from: 'storage-cache' };
  } catch {
    return { envelope: null, from: null };
  }
}

function writeCachedEnvelope(
  envelope: CachedCatalogEnvelope,
  storage: StorageAdapter | null
): void {
  inMemoryEnvelope = envelope;
  inMemoryEmptyUntilMs = 0;
  if (!storage) return;
  try {
    storage.setItem(CATALOG_CACHE_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Ignore QuotaExceededError in private browsing; memory cache still works
  }
}

function readEmptyBackoffUntil(session: StorageAdapter | null): number {
  let until = inMemoryEmptyUntilMs;
  if (session) {
    try {
      const raw = session.getItem(EMPTY_CATALOG_BACKOFF_STORAGE_KEY);
      if (raw) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > until) {
          until = parsed;
        }
      }
    } catch {
      // Ignore storage errors
    }
  }
  return until;
}

function writeEmptyBackoffUntil(untilMs: number, session: StorageAdapter | null): void {
  inMemoryEmptyUntilMs = untilMs;
  if (!session) return;
  try {
    session.setItem(EMPTY_CATALOG_BACKOFF_STORAGE_KEY, String(untilMs));
  } catch {
    // Ignore storage errors
  }
}

function clearEmptyBackoff(session: StorageAdapter | null): void {
  inMemoryEmptyUntilMs = 0;
  if (!session) return;
  try {
    session.removeItem(EMPTY_CATALOG_BACKOFF_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function invalidateCatalogCache(
  storage: StorageAdapter | null = getBrowserLocalStorage(),
  session: StorageAdapter | null = getBrowserSessionStorage()
): void {
  inMemoryEnvelope = null;
  clearEmptyBackoff(session);
  if (!storage) return;
  try {
    storage.removeItem(CATALOG_CACHE_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function getCatalogCacheStatus(
  nowMs = Date.now(),
  storage: StorageAdapter | null = getBrowserLocalStorage()
): {
  hasCache: boolean;
  fresh: boolean;
  version: string | null;
  productCount: number;
  cachedAtMs: number | null;
  expiresAtMs: number | null;
  remainingTtlMs: number;
} {
  const { envelope } = readCachedEnvelope(storage);
  if (!envelope) {
    return {
      hasCache: false,
      fresh: false,
      version: null,
      productCount: 0,
      cachedAtMs: null,
      expiresAtMs: null,
      remainingTtlMs: 0,
    };
  }
  const remainingTtlMs = Math.max(0, envelope.expiresAtMs - nowMs);
  return {
    hasCache: true,
    fresh: nowMs < envelope.expiresAtMs,
    version: envelope.snapshot.version,
    productCount: envelope.snapshot.products.length,
    cachedAtMs: envelope.cachedAtMs,
    expiresAtMs: envelope.expiresAtMs,
    remainingTtlMs,
  };
}

/**
 * Loads the public storefront catalog strictly from:
 *   1. `catalog_meta/public`
 *   2. `catalog_chunks/chunk_N` (only when cache is cold or `version` changed)
 *
 * Guarantees:
 * - Zero collection `list` queries and zero reads of sensitive collections.
 * - Zero throws to storefront callers: returns `fallbackToLegacy: true` whenever
 *   Firestore is empty, incomplete, unreachable, or times out.
 */
export async function loadFirestoreCatalog(
  options: LoadCatalogOptions = {}
): Promise<CatalogLoadResult> {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOG_CACHE_TTL_MS;
  const emptyBackoffMs = options.emptyBackoffMs ?? DEFAULT_EMPTY_BACKOFF_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
  const forceRefresh = Boolean(options.forceRefresh);
  const bypassEmptyBackoff = Boolean(options.bypassEmptyBackoff);
  const revalidateOnColdPageLoad = Boolean(options.revalidateOnColdPageLoad);
  const reader = options.docReader ?? defaultDocReader;
  const storage =
    options.storage === undefined ? getBrowserLocalStorage() : options.storage;
  const session =
    options.sessionStorageAdapter === undefined
      ? getBrowserSessionStorage()
      : options.sessionStorageAdapter;

  // 1. Check Memory / localStorage cache first (0 Firestore reads if within TTL,
  //    unless this is a fresh browser page load requesting a 1-read version check)
  const hadMemoryCache = Boolean(inMemoryEnvelope && isValidCachedEnvelope(inMemoryEnvelope));
  const { envelope: cached, from: cacheFrom } = readCachedEnvelope(storage);
  const shouldSkipStorageShortCircuit = revalidateOnColdPageLoad && !hadMemoryCache;
  if (!forceRefresh && !shouldSkipStorageShortCircuit && cached && nowMs < cached.expiresAtMs) {
    return {
      ok: true,
      source: cacheFrom ?? 'storage-cache',
      snapshot: cached.snapshot,
      readsUsed: 0,
      fallbackToLegacy: false,
    };
  }

  // 2. Avoid repeated server reads if database was recently observed empty
  if (!forceRefresh && !bypassEmptyBackoff && !cached) {
    const emptyUntil = readEmptyBackoffUntil(session);
    if (nowMs < emptyUntil) {
      return {
        ok: false,
        source: 'none',
        snapshot: null,
        readsUsed: 0,
        fallbackToLegacy: true,
        reason: 'empty',
      };
    }
  }

  let readsUsed = 0;
  const metaPath = `${CATALOG_META_COLLECTION}/${CATALOG_META_DOC_ID}`;

  // 3. Read `catalog_meta/public` ONLY (1 Firestore read)
  let metaDoc: CatalogMetaDoc | null = null;
  try {
    readsUsed += 1;
    const metaSnap = await withTimeout(
      reader.getDocFromServer(CATALOG_META_COLLECTION, CATALOG_META_DOC_ID),
      timeoutMs,
      metaPath
    );

    if (!metaSnap.exists()) {
      writeEmptyBackoffUntil(nowMs + emptyBackoffMs, session);
      return {
        ok: false,
        source: 'none',
        snapshot: null,
        readsUsed,
        fallbackToLegacy: true,
        reason: 'empty',
      };
    }

    metaDoc = parseCatalogMetaDoc(metaSnap.data());
    if (!metaDoc) {
      return {
        ok: false,
        source: 'none',
        snapshot: null,
        readsUsed,
        fallbackToLegacy: true,
        reason: 'invalid',
      };
    }
  } catch (error) {
    const errorInfo = buildFirestoreErrorInfo(error, OperationType.GET, metaPath);
    console.warn('Firestore catalog meta unavailable, falling back:', JSON.stringify(errorInfo));

    // If Firestore is temporarily offline, preserve fresh/stale local snapshot if present
    if (cached && cached.snapshot.products.length > 0) {
      return {
        ok: true,
        source: cacheFrom ?? 'storage-cache',
        snapshot: cached.snapshot,
        readsUsed,
        fallbackToLegacy: false,
        errorInfo,
      };
    }

    return {
      ok: false,
      source: 'none',
      snapshot: null,
      readsUsed,
      fallbackToLegacy: true,
      reason: 'error',
      errorInfo,
    };
  }

  clearEmptyBackoff(session);

  // Empty catalog metadata (0 products / 0 chunks) -> let legacy fallback handle gracefully
  if (metaDoc.productCount === 0 || metaDoc.chunkIds.length === 0) {
    return {
      ok: false,
      source: 'none',
      snapshot: null,
      readsUsed,
      fallbackToLegacy: true,
      reason: 'empty',
    };
  }

  // 4. Version check: if `version` matches cached snapshot, skip reading chunks! (Total = 1 read)
  if (!forceRefresh && cached && cached.snapshot.version === metaDoc.version) {
    const refreshedSnapshot: CatalogSnapshot = {
      ...cached.snapshot,
      storeInfo: metaDoc.storeInfo,
      socialLinks: metaDoc.socialLinks,
      updatedAt: metaDoc.updatedAt,
    };
    const refreshedEnvelope: CachedCatalogEnvelope = {
      schemaVersion: 1,
      cachedAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
      snapshot: refreshedSnapshot,
    };
    writeCachedEnvelope(refreshedEnvelope, storage);

    return {
      ok: true,
      source: 'firestore-meta-revalidated',
      snapshot: refreshedSnapshot,
      readsUsed,
      fallbackToLegacy: false,
    };
  }

  // 5. Cold load or version changed -> read each chunk in `metaDoc.chunkIds`
  const mergedProductsById = new Map<string, Product>();
  let activeChunkPath = CATALOG_CHUNKS_COLLECTION;

  try {
    const chunkPromises = metaDoc.chunkIds.map(async (chunkId) => {
      activeChunkPath = `${CATALOG_CHUNKS_COLLECTION}/${chunkId}`;
      readsUsed += 1;
      const chunkSnap = await withTimeout(
        reader.getDocFromServer(CATALOG_CHUNKS_COLLECTION, chunkId),
        timeoutMs,
        activeChunkPath
      );
      if (!chunkSnap.exists()) {
        return { missing: true, chunk: null as CatalogChunkDoc | null };
      }
      const parsedChunk = parseCatalogChunkDoc(chunkSnap.data(), metaDoc!.version);
      return { missing: false, chunk: parsedChunk };
    });

    const chunkResults = await Promise.all(chunkPromises);
    for (const res of chunkResults) {
      if (res.missing || !res.chunk) {
        return {
          ok: false,
          source: 'none',
          snapshot: null,
          readsUsed,
          fallbackToLegacy: true,
          reason: 'incomplete',
        };
      }
      for (const product of res.chunk.items) {
        mergedProductsById.set(product.id, product);
      }
    }
  } catch (error) {
    const errorInfo = buildFirestoreErrorInfo(
      error,
      OperationType.GET,
      activeChunkPath
    );
    console.warn('Firestore catalog chunks unavailable, falling back:', JSON.stringify(errorInfo));

    if (cached && cached.snapshot.products.length > 0) {
      return {
        ok: true,
        source: cacheFrom ?? 'storage-cache',
        snapshot: cached.snapshot,
        readsUsed,
        fallbackToLegacy: false,
        errorInfo,
      };
    }

    return {
      ok: false,
      source: 'none',
      snapshot: null,
      readsUsed,
      fallbackToLegacy: true,
      reason: 'error',
      errorInfo,
    };
  }

  const products = Array.from(mergedProductsById.values()).sort(compareProductsByCode);
  if (products.length === 0 || products.length < metaDoc.productCount) {
    return {
      ok: false,
      source: 'none',
      snapshot: null,
      readsUsed,
      fallbackToLegacy: true,
      reason: 'incomplete',
    };
  }

  const snapshot: CatalogSnapshot = {
    version: metaDoc.version,
    chunkIds: metaDoc.chunkIds,
    storeInfo: metaDoc.storeInfo,
    products,
    socialLinks: metaDoc.socialLinks,
    updatedAt: metaDoc.updatedAt,
  };

  writeCachedEnvelope(
    {
      schemaVersion: 1,
      cachedAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
      snapshot,
    },
    storage
  );

  return {
    ok: true,
    source: 'firestore-full-sync',
    snapshot,
    readsUsed,
    fallbackToLegacy: false,
  };
}
