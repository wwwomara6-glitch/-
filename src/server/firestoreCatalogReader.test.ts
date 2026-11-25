import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FirestoreCatalogReader,
  decodeFirestoreFields,
  decodeFirestoreValue,
} from './firestoreCatalogReader.ts';

test('decodeFirestoreValue and decodeFirestoreFields decode Firestore REST typed values accurately', () => {
  assert.equal(decodeFirestoreValue({ integerValue: '30000' }), 30000);
  assert.equal(decodeFirestoreValue({ doubleValue: 12.5 }), 12.5);
  assert.equal(decodeFirestoreValue({ booleanValue: true }), true);
  assert.equal(decodeFirestoreValue({ nullValue: null }), null);
  assert.equal(decodeFirestoreValue({ stringValue: 'M01' }), 'M01');

  const decoded = decodeFirestoreFields({
    version: { stringValue: 'v1.100' },
    productCount: { integerValue: '2' },
    chunkIds: {
      arrayValue: {
        values: [{ stringValue: 'chunk_000' }],
      },
    },
    storeInfo: {
      mapValue: {
        fields: {
          agencyName: { stringValue: 'وكالة بلوكرانا للعطور' },
          freeDeliveryThresholdIqd: { integerValue: '20000' },
        },
      },
    },
  });

  assert.equal(decoded.version, 'v1.100');
  assert.equal(decoded.productCount, 2);
  assert.deepEqual(decoded.chunkIds, ['chunk_000']);
  assert.deepEqual(decoded.storeInfo, {
    agencyName: 'وكالة بلوكرانا للعطور',
    freeDeliveryThresholdIqd: 20000,
  });
});

test('FirestoreCatalogReader caches by TTL and version, refreshes on version bump, and falls back safely', async () => {
  let version = 'v1.100';
  let chunkPrice = 30000;
  let shouldThrow = false;
  const requestedPaths: string[] = [];

  const reader = new FirestoreCatalogReader({
    ttlMs: 1000,
    fetcher: {
      async getDocument(docPath: string) {
        requestedPaths.push(docPath);
        if (shouldThrow) {
          throw new Error('Simulated Firestore network timeout');
        }
        if (docPath === 'catalog_meta/public') {
          return {
            version,
            updatedAt: '2026-11-25T00:00:00.000Z',
            productCount: 1,
            chunkIds: ['chunk_000'],
            storeInfo: {
              agencyName: 'وكالة بلوكرانا للعطور',
              locationText: 'بعقوبة',
              city: 'ديالى',
              freeDeliveryThresholdIqd: 20000,
              standardDeliveryFeeIqd: 5000,
              guaranteeTitle: 'ضمان',
              guaranteeText: 'تيستر مجاني',
            },
            socialLinks: [
              {
                id: 'soc-1',
                platform: 'واتساب',
                label: 'واتساب',
                handle: '07700000000',
                url: 'https://wa.me/9647700000000',
              },
            ],
          };
        }
        if (docPath === 'catalog_chunks/chunk_000') {
          return {
            version,
            items: [
              {
                id: 'bl-01',
                code: 'M01',
                name: 'عطر اختبار',
                brand: 'بلوكرانا',
                category: 'blaugrana',
                priceIqd: chunkPrice,
                size: '100 مل',
                sizePrices: { '30 مل': 10000, '50 مل': 18000, '100 مل': chunkPrice },
                notes: 'عود · مسك',
                longevity: '24 ساعة',
                sillage: 'ممتاز',
                description: 'وصف',
                imageUrl: 'https://example.com/p.jpg',
                includesFreeTester: true,
                inStock: true,
              },
            ],
          };
        }
        return null;
      },
    },
  });

  // 1. Cold load -> reads meta + chunk
  const first = await reader.getAuthoritativeCatalog({ nowMs: 1000 });
  assert.ok(first);
  assert.equal(first.source, 'firestore-rest');
  assert.equal(first.products[0].priceIqd, 30000);
  assert.deepEqual(requestedPaths, ['catalog_meta/public', 'catalog_chunks/chunk_000']);

  // 2. Within TTL -> hits memory cache without extra network requests
  const second = await reader.getAuthoritativeCatalog({ nowMs: 1500 });
  assert.equal(second?.source, 'cache');
  assert.equal(requestedPaths.length, 2);

  // 3. Past TTL with SAME version -> fetches meta only, skips chunk re-read
  const third = await reader.getAuthoritativeCatalog({ nowMs: 3000 });
  assert.equal(third?.source, 'cache');
  assert.deepEqual(requestedPaths, [
    'catalog_meta/public',
    'catalog_chunks/chunk_000',
    'catalog_meta/public',
  ]);

  // 4. Version bumped -> fetches meta AND updated chunk with new price
  version = 'v1.200';
  chunkPrice = 35000;
  const fourth = await reader.getAuthoritativeCatalog({ nowMs: 5000 });
  assert.equal(fourth?.source, 'firestore-rest');
  assert.equal(fourth?.products[0].priceIqd, 35000);

  // 5. Outage with warm cache returns stale cache
  shouldThrow = true;
  const fifth = await reader.getAuthoritativeCatalog({ nowMs: 10000 });
  assert.equal(fifth?.source, 'cache');
  assert.equal(fifth?.products[0].priceIqd, 35000);

  // 6. Outage with cold/invalidated cache falls back to mirror loader
  reader.invalidateCache();
  const sixth = await reader.getAuthoritativeCatalog({
    nowMs: 11000,
    fallbackCatalog: () => ({
      version: 'mirror',
      updatedAt: '2026-11-25T00:00:00.000Z',
      storeInfo: {
        agencyName: 'مرآة احتياطية',
        locationText: 'بعقوبة',
        city: 'ديالى',
        freeDeliveryThresholdIqd: 20000,
        standardDeliveryFeeIqd: 5000,
        guaranteeTitle: 'ضمان',
        guaranteeText: 'نص',
      },
      products: [],
      socialLinks: [],
    }),
  });
  assert.equal(sixth?.source, 'fallback');
  assert.equal(sixth?.storeInfo.agencyName, 'مرآة احتياطية');
});
