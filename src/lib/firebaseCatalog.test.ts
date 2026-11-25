import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_CATALOG_CACHE_TTL_MS,
  getCatalogCacheStatus,
  invalidateCatalogCache,
  loadFirestoreCatalog,
  type DocReader,
  type StorageAdapter,
} from './firebaseCatalog';
import type { Product, SocialLink, StoreInfo } from '../utils/commerce';

function createMemoryStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, val) => {
      map.set(key, val);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function loadLocal229CatalogFixture(): {
  products: Product[];
  storeInfo: StoreInfo;
  socialLinks: SocialLink[];
} {
  const dbPath = path.resolve(process.cwd(), 'data/blaugrana-db.json');
  const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8')) as {
    products: Product[];
    storeInfo: StoreInfo;
    socialLinks: SocialLink[];
  };
  return parsed;
}

function buildChunkedDocs(
  version: string,
  fixture: {
    products: Product[];
    storeInfo: StoreInfo;
    socialLinks: SocialLink[];
  },
  chunkSize = 120
): Map<string, unknown> {
  const docs = new Map<string, unknown>();
  const chunkIds: string[] = [];

  for (let i = 0; i < fixture.products.length; i += chunkSize) {
    const chunkIndex = chunkIds.length;
    const chunkId = `chunk_${chunkIndex}`;
    chunkIds.push(chunkId);
    docs.set(`catalog_chunks/${chunkId}`, {
      chunkIndex,
      version,
      items: fixture.products.slice(i, i + chunkSize),
      updatedAt: '2026-11-23T22:00:00.000Z',
    });
  }

  docs.set('catalog_meta/public', {
    version,
    productCount: fixture.products.length,
    chunkIds,
    storeInfo: fixture.storeInfo,
    socialLinks: fixture.socialLinks,
    updatedAt: '2026-11-23T22:00:00.000Z',
  });

  return docs;
}

test('Stage 3: Cold load reads catalog_meta/public + 2 chunks (3 reads) for all 229 products', async () => {
  const fixture = loadLocal229CatalogFixture();
  assert.equal(fixture.products.length, 229);

  const docs = buildChunkedDocs('v1.0.0', fixture);
  const pathsRead: string[] = [];
  const docReader: DocReader = {
    async getDocFromServer(col, id) {
      const p = `${col}/${id}`;
      pathsRead.push(p);
      return {
        exists: () => docs.has(p),
        data: () => docs.get(p),
      };
    },
  };

  const storage = createMemoryStorage();
  const session = createMemoryStorage();
  invalidateCatalogCache(storage, session);

  const t0 = 1_700_000_000_000;
  const res1 = await loadFirestoreCatalog({
    nowMs: t0,
    docReader,
    storage,
    sessionStorageAdapter: session,
  });

  assert.equal(res1.ok, true);
  assert.equal(res1.source, 'firestore-full-sync');
  assert.equal(res1.readsUsed, 3);
  assert.equal(res1.fallbackToLegacy, false);
  assert.equal(res1.snapshot?.products.length, 229);
  assert.deepEqual(pathsRead, [
    'catalog_meta/public',
    'catalog_chunks/chunk_0',
    'catalog_chunks/chunk_1',
  ]);

  // Within TTL (< 15 minutes): 0 Firestore reads
  const res2 = await loadFirestoreCatalog({
    nowMs: t0 + 5 * 60 * 1000,
    docReader,
    storage,
    sessionStorageAdapter: session,
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.source, 'memory-cache');
  assert.equal(res2.readsUsed, 0);
  assert.equal(res2.snapshot?.products.length, 229);

  // Cache status check
  const status = getCatalogCacheStatus(t0 + 5 * 60 * 1000, storage);
  assert.equal(status.hasCache, true);
  assert.equal(status.fresh, true);
  assert.equal(status.version, 'v1.0.0');
  assert.equal(status.productCount, 229);
});

test('Stage 3: TTL expiry revalidates via 1 read when version matches, and 3 reads when version changes', async () => {
  const fixture = loadLocal229CatalogFixture();
  let docs = buildChunkedDocs('v1.0.0', fixture);
  const pathsRead: string[] = [];

  const docReader: DocReader = {
    async getDocFromServer(col, id) {
      const p = `${col}/${id}`;
      pathsRead.push(p);
      return {
        exists: () => docs.has(p),
        data: () => docs.get(p),
      };
    },
  };

  const storage = createMemoryStorage();
  const session = createMemoryStorage();
  invalidateCatalogCache(storage, session);

  const t0 = 1_700_000_000_000;
  await loadFirestoreCatalog({
    nowMs: t0,
    docReader,
    storage,
    sessionStorageAdapter: session,
  });
  pathsRead.length = 0;

  // After TTL expires (16 mins), version is still v1.0.0 -> ONLY 1 read (catalog_meta/public)
  const t1 = t0 + DEFAULT_CATALOG_CACHE_TTL_MS + 60_000;
  const revalSame = await loadFirestoreCatalog({
    nowMs: t1,
    docReader,
    storage,
    sessionStorageAdapter: session,
  });
  assert.equal(revalSame.ok, true);
  assert.equal(revalSame.source, 'firestore-meta-revalidated');
  assert.equal(revalSame.readsUsed, 1);
  assert.deepEqual(pathsRead, ['catalog_meta/public']);

  // Version bumped to v1.0.1 -> After next TTL expiry, reads meta + 2 chunks (3 reads)
  pathsRead.length = 0;
  docs = buildChunkedDocs('v1.0.1', fixture);
  const t2 = t1 + DEFAULT_CATALOG_CACHE_TTL_MS + 60_000;
  const revalNew = await loadFirestoreCatalog({
    nowMs: t2,
    docReader,
    storage,
    sessionStorageAdapter: session,
  });
  assert.equal(revalNew.ok, true);
  assert.equal(revalNew.source, 'firestore-full-sync');
  assert.equal(revalNew.readsUsed, 3);
  assert.equal(revalNew.snapshot?.version, 'v1.0.1');
  assert.equal(revalNew.snapshot?.products.length, 229);
});

test('Stage 3: Empty Firestore and network failures gracefully signal legacy fallback without throwing', async () => {
  const storage = createMemoryStorage();
  const session = createMemoryStorage();
  invalidateCatalogCache(storage, session);

  const emptyReader: DocReader = {
    async getDocFromServer() {
      return { exists: () => false, data: () => undefined };
    },
  };

  const t0 = 1_700_000_000_000;
  const emptyRes = await loadFirestoreCatalog({
    nowMs: t0,
    docReader: emptyReader,
    storage,
    sessionStorageAdapter: session,
  });
  assert.equal(emptyRes.ok, false);
  assert.equal(emptyRes.reason, 'empty');
  assert.equal(emptyRes.fallbackToLegacy, true);
  assert.equal(emptyRes.readsUsed, 1);

  // Subsequent visit during empty backoff uses 0 reads
  const emptyBackoffRes = await loadFirestoreCatalog({
    nowMs: t0 + 30_000,
    docReader: emptyReader,
    storage,
    sessionStorageAdapter: session,
  });
  assert.equal(emptyBackoffRes.ok, false);
  assert.equal(emptyBackoffRes.reason, 'empty');
  assert.equal(emptyBackoffRes.fallbackToLegacy, true);
  assert.equal(emptyBackoffRes.readsUsed, 0);

  // Network error on cold cache falls back cleanly without throwing
  invalidateCatalogCache(storage, session);
  const failingReader: DocReader = {
    async getDocFromServer() {
      throw new Error('Failed to get document because the client is offline.');
    },
  };
  const errRes = await loadFirestoreCatalog({
    nowMs: t0,
    docReader: failingReader,
    storage,
    sessionStorageAdapter: session,
  });
  assert.equal(errRes.ok, false);
  assert.equal(errRes.reason, 'error');
  assert.equal(errRes.fallbackToLegacy, true);
  assert.equal(errRes.errorInfo?.operationType, 'get');
  assert.equal(errRes.errorInfo?.path, 'catalog_meta/public');
});
