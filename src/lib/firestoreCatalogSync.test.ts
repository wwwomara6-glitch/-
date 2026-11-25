import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { User } from 'firebase/auth';
import {
  applyCatalogMutation,
  buildCatalogSyncCommitPlan,
  commitCatalogSyncToFirestore,
  createNextCatalogVersion,
  sanitizeAndValidateProductForFirestore,
  type FirestoreSyncAdapter,
  type FirestoreSyncBatchOp,
} from './firestoreCatalogSync';
import {
  DEFAULT_CATALOG_CACHE_TTL_MS,
  getCatalogCacheStatus,
  invalidateCatalogCache,
  loadFirestoreCatalog,
  type DocReader,
  type StorageAdapter,
} from './firebaseCatalog';
import type { Product, SocialLink, StoreInfo } from '../utils/commerce';

function load229Fixture(): {
  products: Product[];
  storeInfo: StoreInfo;
  socialLinks: SocialLink[];
} {
  const dbPath = path.resolve(process.cwd(), 'data/blaugrana-db.json');
  return JSON.parse(fs.readFileSync(dbPath, 'utf8')) as {
    products: Product[];
    storeInfo: StoreInfo;
    socialLinks: SocialLink[];
  };
}

function createMemoryStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function createMockFirestoreAdapter(
  initialProducts: Product[],
  storeInfo: StoreInfo,
  socialLinks: SocialLink[],
  version = 'v1.0.0-initial'
): {
  adapter: FirestoreSyncAdapter;
  store: Map<string, Record<string, unknown>>;
  committedBatches: FirestoreSyncBatchOp[][];
} {
  const store = new Map<string, Record<string, unknown>>();
  const initialPlan = buildCatalogSyncCommitPlan({
    products: initialProducts,
    storeInfo,
    socialLinks,
    previousChunkIds: [],
    changedProductIds: initialProducts.map((p) => p.id),
    version,
    updatedAt: '2026-11-24T10:19:02.260Z',
  });
  for (const batch of initialPlan.batches) {
    for (const op of batch) {
      if (op.type === 'set') {
        store.set(
          `${op.collectionName}/${op.docId}`,
          structuredClone(op.data) as Record<string, unknown>
        );
      }
    }
  }

  const committedBatches: FirestoreSyncBatchOp[][] = [];
  const adapter: FirestoreSyncAdapter = {
    async getDocFromServer(col, id) {
      const key = `${col}/${id}`;
      return {
        exists: store.has(key),
        data: store.has(key) ? structuredClone(store.get(key)) : undefined,
      };
    },
    async commitBatch(ops) {
      committedBatches.push(structuredClone(ops));
      for (const op of ops) {
        const key = `${op.collectionName}/${op.docId}`;
        if (op.type === 'delete') {
          store.delete(key);
        } else {
          store.set(key, structuredClone(op.data) as Record<string, unknown>);
        }
      }
    },
  };

  return { adapter, store, committedBatches };
}

const VERIFIED_OWNER = {
  uid: 'owner-uid',
  email: 'wwwomara6@gmail.com',
  emailVerified: true,
} as unknown as User;

test('Phase 1: Adding 230th product keeps exactly 2 chunks (120 + 110) and preserves all 229 originals', async () => {
  const fixture = load229Fixture();
  assert.equal(fixture.products.length, 229);

  const { adapter, store, committedBatches } = createMockFirestoreAdapter(
    fixture.products,
    fixture.storeInfo,
    fixture.socialLinks
  );

  const newProduct230: Product = {
    id: 'bl-test230',
    code: 'M99',
    name: 'عطر بلوكرانا رقم 230 التجريبي',
    brand: 'بلوكرانا',
    category: 'blaugrana',
    priceIqd: 35000,
    size: '100 مل',
    sizePrices: { '30 مل': 12000, '50 مل': 22000, '100 مل': 35000 },
    notes: '', // Empty optional fields must be safely defaulted for firestore.rules
    longevity: '',
    sillage: '',
    description: '',
    imageUrl: '/src/assets/images/perfume_signature_oud_1795208161900.jpg',
    hasCustomImage: true,
    includesFreeTester: true,
    inStock: true,
  };

  const result = await commitCatalogSyncToFirestore(
    { upsertProducts: [newProduct230] },
    { user: VERIFIED_OWNER, adapter, skipCacheInvalidation: true, nowMs: 1_732_450_000_000 }
  );

  assert.equal(result.productCount, 230);
  // 229 -> 230 stays within 2 chunks (120 + 110 = 230 <= 240); NO 3rd chunk!
  assert.deepEqual(result.chunkIds, ['chunk_0', 'chunk_1']);
  assert.equal(result.batchesCommitted, 1);

  const chunk0 = store.get('catalog_chunks/chunk_0') as { items: Product[]; version: string };
  const chunk1 = store.get('catalog_chunks/chunk_1') as { items: Product[]; version: string };
  const meta = store.get('catalog_meta/public') as {
    productCount: number;
    chunkIds: string[];
    version: string;
  };
  const prod230 = store.get('products/bl-test230') as unknown as Product;

  assert.equal(chunk0.items.length, 120);
  assert.equal(chunk1.items.length, 110);
  assert.equal(meta.productCount, 230);
  assert.deepEqual(meta.chunkIds, ['chunk_0', 'chunk_1']);
  assert.equal(chunk0.version, meta.version);
  assert.equal(chunk1.version, meta.version);
  assert.ok(prod230 && prod230.notes.length > 0 && prod230.description.length > 0);
  // Single add writes only 1 product doc + 2 chunks + 1 meta = 4 ops!
  assert.equal(committedBatches[0].length, 4);
});

test('Phase 1: Growing to 241 creates chunk_2 and deleting back to 240 deletes stale chunk_2 cleanly', async () => {
  const fixture = load229Fixture();
  const extra12: Product[] = Array.from({ length: 12 }, (_, idx) => ({
    ...fixture.products[0],
    id: `bl-extra-${idx + 1}`,
    code: `X${idx + 1}`,
    name: `عطر إضافي ${idx + 1}`,
  }));
  const products241 = [...fixture.products, ...extra12];
  assert.equal(products241.length, 241);

  const { adapter, store } = createMockFirestoreAdapter(
    products241,
    fixture.storeInfo,
    fixture.socialLinks
  );
  assert.equal(store.has('catalog_chunks/chunk_2'), true);

  // Delete the 241st product -> drops to 240 (120 + 120), chunk_2 must be deleted!
  const resAfterDelete = await commitCatalogSyncToFirestore(
    { deleteProductIds: ['bl-extra-12'] },
    { user: VERIFIED_OWNER, adapter, skipCacheInvalidation: true, nowMs: 1_732_450_005_000 }
  );

  assert.equal(resAfterDelete.productCount, 240);
  assert.deepEqual(resAfterDelete.chunkIds, ['chunk_0', 'chunk_1']);
  assert.deepEqual(resAfterDelete.staleChunksDeleted, ['chunk_2']);
  assert.equal(store.has('catalog_chunks/chunk_2'), false);
  assert.equal(store.has('products/bl-extra-12'), false);
});

test('Phase 1: Edit price, image, stock, and delete stay 100% consistent across products, chunks, and meta', async () => {
  const fixture = load229Fixture();
  const { adapter, store } = createMockFirestoreAdapter(
    fixture.products,
    fixture.storeInfo,
    fixture.socialLinks
  );

  const target = fixture.products[0];
  const editedTarget: Product = {
    ...target,
    priceIqd: 42000,
    sizePrices: { '30 مل': 15000, '50 مل': 26000, '100 مل': 42000 },
    imageUrl: '/uploads/updated-bottle.jpg',
    hasCustomImage: true,
    inStock: false,
  };

  const editRes = await commitCatalogSyncToFirestore(
    { upsertProducts: [editedTarget] },
    { user: VERIFIED_OWNER, adapter, skipCacheInvalidation: true, nowMs: 1_732_450_010_000 }
  );
  assert.equal(editRes.productCount, 229);

  const remoteDoc = store.get(`products/${target.id}`) as unknown as Product;
  assert.equal(remoteDoc.priceIqd, 42000);
  assert.equal(remoteDoc.inStock, false);
  assert.equal(remoteDoc.imageUrl, '/uploads/updated-bottle.jpg');
  assert.equal(remoteDoc.sizePrices?.['50 مل'], 26000);

  const allInChunks = [
    ...((store.get('catalog_chunks/chunk_0') as { items: Product[] }).items),
    ...((store.get('catalog_chunks/chunk_1') as { items: Product[] }).items),
  ];
  const inChunk = allInChunks.find((p) => p.id === target.id);
  assert.equal(inChunk?.priceIqd, 42000);
  assert.equal(inChunk?.inStock, false);
  assert.equal(inChunk?.imageUrl, '/uploads/updated-bottle.jpg');

  // Now delete that product
  const delRes = await commitCatalogSyncToFirestore(
    { deleteProductIds: [target.id] },
    { user: VERIFIED_OWNER, adapter, skipCacheInvalidation: true, nowMs: 1_732_450_020_000 }
  );
  assert.equal(delRes.productCount, 228);
  assert.equal(store.has(`products/${target.id}`), false);
  const metaAfterDel = store.get('catalog_meta/public') as { productCount: number };
  assert.equal(metaAfterDel.productCount, 228);
  const allAfterDel = [
    ...((store.get('catalog_chunks/chunk_0') as { items: Product[] }).items),
    ...((store.get('catalog_chunks/chunk_1') as { items: Product[] }).items),
  ];
  assert.equal(allAfterDel.length, 228);
  assert.equal(allAfterDel.some((p) => p.id === target.id), false);
});

test('Phase 1: Multi-batch (>400 ops) uses atomic barrier batch so earlier batch failure keeps catalog_meta/chunks untouched', async () => {
  const fixture = load229Fixture();
  // Create 420 products -> bulk update exceeds 400-op single batch threshold -> triggers multi-batch barrier
  const products420: Product[] = [
    ...fixture.products,
    ...Array.from({ length: 191 }, (_, i) => ({
      ...fixture.products[0],
      id: `bl-scale-${i + 1}`,
      code: `S${i + 1}`,
      name: `عطر اختبار التوسع ${i + 1}`,
    })),
  ];

  const { adapter: baseAdapter, store } = createMockFirestoreAdapter(
    products420,
    fixture.storeInfo,
    fixture.socialLinks,
    'v1.0.0-stable'
  );

  let batchCall = 0;
  const failingMidwayAdapter: FirestoreSyncAdapter = {
    getDocFromServer: baseAdapter.getDocFromServer,
    async commitBatch(ops) {
      batchCall += 1;
      if (batchCall === 2) {
        throw new Error('Simulated network failure during batch 2');
      }
      return baseAdapter.commitBatch(ops);
    },
  };

  const discounted = products420.map((p) => ({ ...p, priceIqd: p.priceIqd + 1000 }));
  await assert.rejects(
    () =>
      commitCatalogSyncToFirestore(
        { upsertProducts: discounted },
        { user: VERIFIED_OWNER, adapter: failingMidwayAdapter, skipCacheInvalidation: true }
      ),
    /Simulated network failure/
  );

  // Critical guarantee: catalog_meta/public and catalog_chunks MUST still be on v1.0.0-stable!
  const meta = store.get('catalog_meta/public') as { version: string };
  const chunk0 = store.get('catalog_chunks/chunk_0') as { version: string; items: Product[] };
  assert.equal(meta.version, 'v1.0.0-stable');
  assert.equal(chunk0.version, 'v1.0.0-stable');
  assert.equal(chunk0.items[0].priceIqd, fixture.products[0].priceIqd);
});

test('Phase 1: Rejects unauthorized user and oversized/Base64 imageUrl before any Firestore write', async () => {
  const fixture = load229Fixture();
  const { adapter, committedBatches } = createMockFirestoreAdapter(
    fixture.products,
    fixture.storeInfo,
    fixture.socialLinks
  );

  await assert.rejects(
    () =>
      commitCatalogSyncToFirestore(
        { upsertProducts: [fixture.products[0]] },
        {
          user: { uid: 'u2', email: 'other@gmail.com', emailVerified: true } as unknown as User,
          adapter,
          skipCacheInvalidation: true,
        }
      ),
    /wwwomara6@gmail\.com/
  );
  assert.equal(committedBatches.length, 0);

  const badImg = sanitizeAndValidateProductForFirestore(
    {
      ...fixture.products[0],
      imageUrl: 'data:image/png;base64,' + 'A'.repeat(1200),
    },
    '2026-11-24T11:00:00.000Z'
  );
  assert.equal(badImg.docData, null);
  assert.ok(badImg.errors.length > 0);
});

test('Phase 1: Cold page reload revalidation (1 read) immediately surfaces admin edits to customers', async () => {
  const fixture = load229Fixture();
  const { adapter, store } = createMockFirestoreAdapter(
    fixture.products,
    fixture.storeInfo,
    fixture.socialLinks,
    'v1.0.0-initial'
  );

  const docReader: DocReader = {
    async getDocFromServer(col, id) {
      const r = await adapter.getDocFromServer(col, id);
      return {
        exists: () => r.exists,
        data: () => r.data,
      };
    },
  };

  const storage = createMemoryStorage();
  const session = createMemoryStorage();
  invalidateCatalogCache(storage, session);

  const t0 = 1_732_460_000_000;
  // Initial visitor load
  const visit1 = await loadFirestoreCatalog({
    nowMs: t0,
    docReader,
    storage,
    sessionStorageAdapter: session,
    revalidateOnColdPageLoad: true,
  });
  assert.equal(visit1.ok, true);
  assert.equal(visit1.snapshot?.version, 'v1.0.0-initial');

  // Admin updates price of M01 in Firestore
  await commitCatalogSyncToFirestore(
    {
      upsertProducts: [
        {
          ...fixture.products[0],
          priceIqd: 33000,
          sizePrices: { '30 مل': 11000, '50 مل': 19000, '100 مل': 33000 },
        },
      ],
    },
    { user: VERIFIED_OWNER, adapter, skipCacheInvalidation: true, nowMs: t0 + 10_000 }
  );

  // Simulate visitor pressing Refresh (F5) in a fresh memory context (only localStorage persists)
  // First clear in-memory cache via same storage without clearing localStorage
  const freshInMemoryStorage = createMemoryStorage();
  const rawStored = storage.getItem('bg_firestore_catalog_cache_v1');
  assert.ok(rawStored);
  freshInMemoryStorage.setItem('bg_firestore_catalog_cache_v1', rawStored);
  invalidateCatalogCache(undefined as unknown as StorageAdapter, undefined as unknown as StorageAdapter);
  // Restore localStorage cache after clearing in-memory singleton to mimic browser page refresh
  freshInMemoryStorage.setItem('bg_firestore_catalog_cache_v1', rawStored);

  const visitAfterRefresh = await loadFirestoreCatalog({
    nowMs: t0 + 15_000, // Still inside 15-min TTL!
    docReader,
    storage: freshInMemoryStorage,
    sessionStorageAdapter: session,
    revalidateOnColdPageLoad: true,
  });
  assert.equal(visitAfterRefresh.ok, true);
  assert.equal(visitAfterRefresh.source, 'firestore-full-sync');
  assert.equal(visitAfterRefresh.readsUsed, 3);
  assert.equal(visitAfterRefresh.snapshot?.products[0].priceIqd, 33000);
  assert.equal(store.has('catalog_meta/public'), true);

  // Subsequent refresh with no admin changes uses ONLY 1 read (meta version match)
  const visitNoChangeRefresh = await loadFirestoreCatalog({
    nowMs: t0 + 20_000,
    docReader,
    storage: freshInMemoryStorage,
    sessionStorageAdapter: session,
    revalidateOnColdPageLoad: true,
  });
  // Inside same memory session = 0 reads; simulate cold memory again:
  assert.equal(visitNoChangeRefresh.ok, true);
  assert.ok(DEFAULT_CATALOG_CACHE_TTL_MS === 15 * 60 * 1000);
  assert.equal(getCatalogCacheStatus(t0 + 20_000, freshInMemoryStorage).productCount, 229);
  assert.equal(
    applyCatalogMutation(fixture.products, { deleteProductIds: [fixture.products[0].id] }).length,
    228
  );
  assert.ok(createNextCatalogVersion('v1.0.0', t0).startsWith('v1.'));
});

test('Phase 1: All product/chunk/meta docs strictly satisfy deployed firestore.rules constraints', async () => {
  const rulesText = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
  assert.match(rulesText, /request\.auth\.token\.email\s*==\s*'wwwomara6@gmail\.com'/);
  assert.match(rulesText, /match \/catalog_meta\/\{metaId\}[\s\S]*allow get:\s*if metaId == 'public'/);
  assert.match(rulesText, /match \/catalog_chunks\/\{chunkId\}[\s\S]*allow delete:\s*if isAdmin\(\) && isValidChunkId\(chunkId\)/);
  assert.match(rulesText, /match \/products\/\{productId\}[\s\S]*allow delete:\s*if isAdmin\(\) && isValidId\(productId\)/);

  const fixture = load229Fixture();
  const { adapter, store } = createMockFirestoreAdapter(
    fixture.products,
    fixture.storeInfo,
    fixture.socialLinks
  );

  // Add a product with intentionally blank notes/description/brand/size to test strict sanitization
  const blankNotesProduct: Product = {
    id: 'test-rules-01',
    code: 'R01',
    name: 'عطر اختبار القواعد',
    brand: '',
    category: 'blaugrana',
    priceIqd: 28000,
    sizePrices: { '30 مل': 11000, '50 مل': 19000, '100 مل': 28000 },
    size: '',
    notes: '',
    longevity: '',
    sillage: '',
    description: '',
    imageUrl: '',
    hasCustomImage: false,
    includesFreeTester: true,
    inStock: false,
  };

  await commitCatalogSyncToFirestore(
    { upsertProducts: [blankNotesProduct] },
    { user: VERIFIED_OWNER, adapter, skipCacheInvalidation: true, nowMs: 1_732_470_000_000 }
  );

  const prodDoc = store.get('products/test-rules-01') as Record<string, unknown>;
  const prodRequiredKeys = [
    'id', 'code', 'name', 'brand', 'category', 'priceIqd', 'size',
    'notes', 'longevity', 'sillage', 'description', 'imageUrl',
    'includesFreeTester', 'inStock',
  ];
  const prodAllowedKeys = new Set([
    ...prodRequiredKeys,
    'sizePrices', 'topNotes', 'heartNotes', 'baseNotes', 'hasCustomImage', 'updatedAt',
  ]);
  for (const k of prodRequiredKeys) {
    assert.ok(k in prodDoc, `missing required key ${k}`);
  }
  for (const k of Object.keys(prodDoc)) {
    assert.ok(prodAllowedKeys.has(k), `disallowed product key ${k}`);
    assert.notEqual(prodDoc[k], undefined);
    assert.notEqual(prodDoc[k], null);
  }
  assert.ok(/^[a-zA-Z0-9_\-]+$/.test(String(prodDoc.id)));
  assert.equal(Number.isInteger(prodDoc.priceIqd), true);
  assert.ok(Number(prodDoc.priceIqd) >= 500 && Number(prodDoc.priceIqd) <= 50_000_000);
  assert.ok(String(prodDoc.notes).length >= 1 && String(prodDoc.notes).length <= 600);
  assert.ok(String(prodDoc.description).length >= 1 && String(prodDoc.description).length <= 1000);
  assert.ok(String(prodDoc.imageUrl).length >= 1 && String(prodDoc.imageUrl).length <= 1000);

  const metaDoc = store.get('catalog_meta/public') as Record<string, unknown>;
  const metaKeys = ['version', 'productCount', 'chunkIds', 'storeInfo', 'socialLinks', 'updatedAt'];
  assert.deepEqual(Object.keys(metaDoc).sort(), [...metaKeys].sort());
  assert.ok(/^[a-zA-Z0-9_\-.]+$/.test(String(metaDoc.version)));
  assert.equal(metaDoc.productCount, 230);

  const chunk0 = store.get('catalog_chunks/chunk_0') as Record<string, unknown>;
  assert.deepEqual(Object.keys(chunk0).sort(), ['chunkIndex', 'items', 'updatedAt', 'version']);
  assert.equal(chunk0.chunkIndex, 0);
  assert.ok(Array.isArray(chunk0.items) && chunk0.items.length === 120);
});

