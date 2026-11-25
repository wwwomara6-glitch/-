import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_PRODUCT_IMAGE_BYTES,
  StoreValidationError,
  TursoStore,
  WriteFreezeError,
  assertSafeDatabaseTarget,
  sha256Hex,
} from './tursoStore.ts';
import type { Product } from '../utils/commerce.ts';

function createSampleProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'bl-test-1',
    code: 'M01',
    name: 'عطر اختباري فاخر',
    brand: 'بلوكرانا',
    category: 'blaugrana',
    priceIqd: 30000,
    size: '100 مل',
    sizePrices: { '30 مل': 10000, '50 مل': 18000, '100 مل': 30000 },
    notes: 'برغموت · عنبر',
    longevity: '24 ساعة',
    sillage: 'فوحان قوي',
    description: 'وصف اختباري',
    imageUrl: '/src/assets/images/perfume_signature_oud_1795208161900.jpg',
    hasCustomImage: false,
    includesFreeTester: true,
    inStock: true,
    ...overrides,
  };
}

function createTempStore(t: test.TestContext): TursoStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-turso-test-'));
  const dbFile = path.join(dir, 'staging.sqlite');
  const store = new TursoStore({
    url: `file:${dbFile}`,
    isTestMode: true,
  });
  t.after(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test('assertSafeDatabaseTarget blocks production URLs in test mode and allows isolated test targets', () => {
  assert.throws(
    () => assertSafeDatabaseTarget('libsql://blaugrana-prod.turso.io', { isTestMode: true }),
    /Refusing to run tests/
  );
  assert.throws(
    () => assertSafeDatabaseTarget('https://customer-live.turso.io', { isTestMode: true }),
    /Refusing to run tests/
  );
  assert.doesNotThrow(() => assertSafeDatabaseTarget(':memory:', { isTestMode: true }));
  assert.doesNotThrow(() => assertSafeDatabaseTarget('file:/tmp/bg-test.sqlite', { isTestMode: true }));
  assert.doesNotThrow(() =>
    assertSafeDatabaseTarget('libsql://blaugrana-staging.turso.io', { isTestMode: true })
  );
});

test('createOrderAtomic rolls back order, counter, loyalty, promo usage, and notification on mid-transaction failure', async (t) => {
  const store = createTempStore(t);
  await store.ensureSchema();

  await store.createPromoCode({
    id: 'pr-tx-1',
    code: 'TX10',
    ownerName: 'مختبر',
    discountType: 'percent',
    discountValue: 10,
    durationDays: 30,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    active: true,
    timesUsed: 0,
    createdAt: new Date().toISOString(),
  });

  const prod = createSampleProduct();

  await assert.rejects(
    () =>
      store.createOrderAtomic({
        fullName: 'زبون اختبار التراجع',
        exactLocation: 'ديالى - بعقوبة - التحرير',
        birthDate: '1998-05-10',
        phone: '07700000001',
        promoCode: 'TX10',
        resolvedCart: [{ product: prod, selectedSize: '100 مل', unitPriceIqd: 30000, quantity: 2 }],
        testHooks: {
          beforeCommit: () => {
            throw new Error('Injected failure before commit');
          },
        },
      }),
    /Injected failure before commit/
  );

  assert.equal((await store.listOrders()).length, 0);
  assert.equal((await store.listNotifications()).length, 0);
  assert.equal(await store.getOrderSequence(), 1001);
  assert.equal(await store.getLoyaltyCount(), 0);
  const promo = await store.findPromoByCode('TX10');
  assert.equal(promo?.timesUsed, 0);
});

test('createOrderAtomic sequentially increments order_sequence, tracks 4+1 loyalty, and increments promo timesUsed', async (t) => {
  const store = createTempStore(t);
  await store.ensureSchema();

  await store.createPromoCode({
    id: 'pr-ok-1',
    code: 'VIP5000',
    ownerName: 'أحمد',
    discountType: 'fixed',
    discountValue: 5000,
    durationDays: 10,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    active: true,
    timesUsed: 0,
    createdAt: new Date().toISOString(),
  });

  await store.createPromoCode({
    id: 'pr-exp-1',
    code: 'OLD10',
    ownerName: 'منتهي',
    discountType: 'percent',
    discountValue: 10,
    durationDays: 1,
    expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    active: true,
    timesUsed: 0,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  });

  const prod = createSampleProduct();

  const first = await store.createOrderAtomic({
    fullName: 'علي حسن',
    exactLocation: 'بغداد - الكرادة - قرب الساحة',
    birthDate: '1995-01-01',
    phone: '07700000002',
    promoCode: 'VIP5000',
    resolvedCart: [{ product: prod, selectedSize: '100 مل', unitPriceIqd: 30000, quantity: 3 }],
  });

  assert.equal(first.order.orderNumber, 'BG-1001');
  assert.equal(first.loyalty.totalQualifyingPerfumes, 3);
  assert.equal(first.loyalty.stamps, 3);
  assert.equal(first.loyalty.stampsRemainingForFree, 2);
  assert.equal(first.order.pricing.promoDiscountIqd, 5000);
  assert.equal(first.order.pricing.totalIqd, 85000);

  // Second order completes the 4+1 free perfume cycle
  const second = await store.createOrderAtomic({
    fullName: 'علي حسن',
    exactLocation: 'بغداد - الكرادة - قرب الساحة',
    birthDate: '1995-01-01',
    phone: '07700000002',
    resolvedCart: [{ product: prod, selectedSize: '100 مل', unitPriceIqd: 30000, quantity: 2 }],
  });

  assert.equal(second.order.orderNumber, 'BG-1002');
  assert.equal(second.order.pricing.freePerfumeUnitsEarned, 1);
  assert.equal(second.order.pricing.loyaltyDiscountIqd, 30000);
  assert.equal(second.loyalty.freePerfumesRedeemed, 1);
  assert.equal(second.loyalty.ordersCount, 2);
  assert.equal(await store.getOrderSequence(), 1003);
  assert.equal((await store.findPromoByCode('VIP5000'))?.timesUsed, 1);

  await assert.rejects(
    () =>
      store.createOrderAtomic({
        fullName: 'سارة كريم',
        exactLocation: 'ديالى - بعقوبة - المركز',
        birthDate: '1999-03-04',
        phone: '07700000003',
        promoCode: 'OLD10',
        resolvedCart: [{ product: prod, selectedSize: '100 مل', unitPriceIqd: 30000, quantity: 1 }],
      }),
    (err: unknown) => err instanceof StoreValidationError && err.statusCode === 410
  );
});

test('write_freeze blocks all mutations while preserving read queries', async (t) => {
  const store = createTempStore(t);
  await store.ensureSchema();

  const prod = createSampleProduct();
  const created = await store.createOrderAtomic({
    fullName: 'مشتري قبل التجميد',
    exactLocation: 'ديالى - بعقوبة - التكية',
    birthDate: '1990-02-02',
    phone: '07700000004',
    resolvedCart: [{ product: prod, selectedSize: '100 مل', unitPriceIqd: 30000, quantity: 1 }],
  });

  const freezeState = await store.setWriteFreeze(true, 'تجميد اختباري');
  assert.equal(freezeState.frozen, true);
  assert.equal(await store.isWriteFrozen(), true);

  await assert.rejects(
    () =>
      store.createOrderAtomic({
        fullName: 'مشتري أثناء التجميد',
        exactLocation: 'ديالى - بعقوبة - التكية',
        birthDate: '1990-02-02',
        phone: '07700000005',
        resolvedCart: [{ product: prod, selectedSize: '100 مل', unitPriceIqd: 30000, quantity: 1 }],
      }),
    WriteFreezeError
  );
  await assert.rejects(
    () =>
      store.createCustomRequestAtomic({
        perfumeName: 'عطر نادر',
        expectedPriceIqd: 45000,
        size: '100 مل',
        desiredDate: '2026-12-01',
        customerName: 'طارق',
        customerPhone: '07700000006',
        notes: '',
      }),
    WriteFreezeError
  );
  await assert.rejects(
    () => store.updateOrderStatus(created.order.id, { status: 'تم التجهيز' }),
    WriteFreezeError
  );

  // Reads still work cleanly during maintenance freeze
  assert.equal((await store.trackOrder(created.order.orderNumber, '07700000004'))?.id, created.order.id);
  assert.equal((await store.getLoyaltyByPhone('07700000004')).ordersCount, 1);

  await store.setWriteFreeze(false);
  assert.equal(await store.isWriteFrozen(), false);
});

test('product_images validates magic bytes (JPG/PNG/WebP), rejects SVG/oversized, and computes SHA-256', async (t) => {
  const store = createTempStore(t);
  await store.ensureSchema();

  // Valid 1x1 PNG
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const savedPng = await store.saveProductImage(
    `data:image/png;base64,${pngBytes.toString('base64')}`
  );
  assert.equal(savedPng.ext, 'png');
  assert.equal(savedPng.mimeType, 'image/png');
  assert.equal(savedPng.sha256, sha256Hex(pngBytes));

  const fetched = await store.getProductImage(`${savedPng.id}.png`);
  assert.ok(fetched);
  assert.deepEqual(Buffer.from(fetched.data), pngBytes);

  // Valid minimal WebP header (RIFF....WEBP)
  const webpBuf = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x10, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from([0x56, 0x50, 0x38, 0x20, 0x04, 0x00, 0x00, 0x00]),
  ]);
  const savedWebp = await store.saveProductImage(
    `data:image/webp;base64,${webpBuf.toString('base64')}`
  );
  assert.equal(savedWebp.ext, 'webp');

  // Reject SVG
  const svgB64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  await assert.rejects(
    () => store.saveProductImage(`data:image/svg+xml;base64,${svgB64}`),
    (err: unknown) => err instanceof StoreValidationError && err.statusCode === 400
  );

  // Reject spoofed PNG header (text bytes declared as image/png)
  await assert.rejects(
    () => store.saveProductImage(`data:image/png;base64,${Buffer.from('not-a-real-png-binary').toString('base64')}`),
    (err: unknown) => err instanceof StoreValidationError && err.statusCode === 400
  );

  // Reject > 1.5 MiB image
  const oversized = Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES + 128, 0);
  oversized[0] = 0x89;
  oversized[1] = 0x50;
  oversized[2] = 0x4e;
  oversized[3] = 0x47;
  await assert.rejects(
    () => store.saveProductImage(`data:image/png;base64,${oversized.toString('base64')}`),
    (err: unknown) => err instanceof StoreValidationError && err.statusCode === 413
  );

  // Reject invalid/traversal ID lookup
  assert.equal(await store.getProductImage('../../etc/passwd'), null);
});

test('exportOperationalState produces verifiable SHA-256 over operational payload', async (t) => {
  const store = createTempStore(t);
  await store.ensureSchema();

  await store.createCustomRequestAtomic({
    perfumeName: 'عطر تصدير',
    expectedPriceIqd: 40000,
    size: '100 مل',
    desiredDate: '2026-12-15',
    customerName: 'زينب',
    customerPhone: '07700000009',
    notes: '',
  });

  const exported = await store.exportOperationalState();
  assert.equal(exported.storageEngine, 'turso');
  assert.equal(exported.data.customRequests.length, 1);
  assert.equal(exported.integrity.dataSectionSha256, sha256Hex(JSON.stringify(exported.data)));
});
