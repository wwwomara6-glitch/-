import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../../server.ts';
import { FirestoreCatalogReader } from './firestoreCatalogReader.ts';
import { TursoStore } from './tursoStore.ts';

async function startTestServer(
  t: test.TestContext,
  overrides: {
    turso?: TursoStore | null;
    strictNoLocalWrites?: boolean;
    rateLimitMaxAuth?: number;
    rateLimitMaxWrites?: number;
  } = {}
) {
  let store: TursoStore | null = null;
  if (overrides.turso === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-http-test-'));
    store = new TursoStore({
      url: `file:${path.join(dir, 'http.sqlite')}`,
      isTestMode: true,
    });
    await store.ensureSchema();
    t.after(async () => {
      await store?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  } else {
    store = overrides.turso;
    if (store) await store.ensureSchema();
  }

  const catalogReader = new FirestoreCatalogReader({
    fetcher: {
      async getDocument(docPath: string) {
        if (docPath === 'catalog_meta/public') {
          return {
            version: 'v1.test',
            updatedAt: '2026-11-25T00:00:00.000Z',
            productCount: 1,
            chunkIds: ['chunk_000'],
            storeInfo: {
              agencyName: 'وكالة بلوكرانا للعطور',
              locationText: 'ديالى - بعقوبة',
              city: 'ديالى',
              freeDeliveryThresholdIqd: 20000,
              standardDeliveryFeeIqd: 5000,
              guaranteeTitle: 'ضمان',
              guaranteeText: 'تيستر مجاني',
            },
            socialLinks: [],
          };
        }
        if (docPath === 'catalog_chunks/chunk_000') {
          return {
            version: 'v1.test',
            items: [
              {
                id: 'p-101',
                code: 'M10',
                name: 'عطر بلوكرانا المرجعي',
                brand: 'بلوكرانا',
                category: 'blaugrana',
                priceIqd: 30000,
                size: '100 مل',
                sizePrices: { '30 مل': 10000, '50 مل': 18000, '100 مل': 30000 },
                notes: 'برغموت · مسك',
                longevity: '24 ساعة',
                sillage: 'قوي',
                description: 'وصف',
                imageUrl: '/src/assets/images/perfume_signature_oud_1795208161900.jpg',
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

  const { app } = createApp({
    tursoStore: store,
    catalogReader,
    strictNoLocalWrites: overrides.strictNoLocalWrites ?? true,
    apiOnly: true,
    allowedOrigins: ['https://blaugrana-shop.web.app'],
    adminPasscode: 'test-admin-2026',
    sessionSecret: 'test-session-secret-0123456789abcdef',
    rateLimitMaxAuth: overrides.rateLimitMaxAuth ?? 100,
    rateLimitMaxWrites: overrides.rateLimitMaxWrites ?? 100,
    rateLimitWindowMs: 60_000,
  });

  const server = await new Promise<http.Server>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { baseUrl, store };
}

test('HTTP integration: health, strict CORS allowlist, authoritative Firestore pricing, persistent image serving (ETag/304), export SHA-256, and maintenance freeze', async (t) => {
  const { baseUrl } = await startTestServer(t);

  // 1. Health check
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  const health = (await healthRes.json()) as {
    ok: boolean;
    storageEngine: string;
    dbConnected: boolean;
    writeFreeze: boolean;
  };
  assert.equal(health.ok, true);
  assert.equal(health.storageEngine, 'turso');
  assert.equal(health.dbConnected, true);
  assert.equal(health.writeFreeze, false);

  // 2. CORS allowlist check
  const allowedCors = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: 'https://blaugrana-shop.web.app' },
  });
  assert.equal(allowedCors.status, 200);
  assert.equal(allowedCors.headers.get('access-control-allow-origin'), 'https://blaugrana-shop.web.app');

  const evilCors = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: 'https://evil-attacker.example' },
  });
  assert.equal(evilCors.status, 403);
  const evilBody = (await evilCors.json()) as { code: string };
  assert.equal(evilBody.code, 'CORS_ORIGIN_FORBIDDEN');

  // 3. Create order with forged client price -> server enforces 30,000 IQD from FirestoreCatalogReader
  const orderRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'حيدر عادل',
      exactLocation: 'ديالى - بعقوبة - حي المعلمين',
      birthDate: '1994-07-12',
      phone: '07700000050',
      items: [
        {
          productId: 'p-101',
          selectedSize: '100 مل',
          priceIqd: 1, // forged price ignored by server
          quantity: 1,
        },
      ],
    }),
  });
  assert.equal(orderRes.status, 201);
  const orderBody = (await orderRes.json()) as {
    order: { orderNumber: string; pricing: { rawSubtotalIqd: number; totalIqd: number } };
    loyalty: { stamps: number; voucherCode: string };
  };
  assert.equal(orderBody.order.orderNumber, 'BG-1001');
  assert.equal(orderBody.order.pricing.rawSubtotalIqd, 30000);
  assert.equal(orderBody.order.pricing.totalIqd, 30000);
  assert.equal(orderBody.loyalty.stamps, 1);

  // Track order immediately via GET
  const trackRes = await fetch(
    `${baseUrl}/api/orders/track?orderNumber=BG-1001&phone=07700000050`
  );
  assert.equal(trackRes.status, 200);

  // 4. Admin login & persistent image upload -> GET /api/images/:id with ETag / 304
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'test-admin-2026' }),
  });
  assert.equal(loginRes.status, 200);
  const { token } = (await loginRes.json()) as { token: string };
  assert.ok(token);

  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const uploadRes = await fetch(`${baseUrl}/api/admin/upload-image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ dataUrl: `data:image/png;base64,${pngBase64}` }),
  });
  assert.equal(uploadRes.status, 201);
  const uploadJson = (await uploadRes.json()) as { imageUrl: string; sha256: string };
  assert.ok(uploadJson.imageUrl.includes('/api/images/'));
  assert.ok(uploadJson.imageUrl.length <= 1000);

  const imgPath = new URL(uploadJson.imageUrl).pathname;
  const imgGet = await fetch(`${baseUrl}${imgPath}`);
  assert.equal(imgGet.status, 200);
  assert.equal(imgGet.headers.get('content-type'), 'image/png');
  assert.equal(imgGet.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(imgGet.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const etag = imgGet.headers.get('etag');
  assert.ok(etag);

  const img304 = await fetch(`${baseUrl}${imgPath}`, {
    headers: { 'If-None-Match': etag },
  });
  assert.equal(img304.status, 304);

  // 5. Maintenance freeze blocks ALL write endpoints cleanly with 503 MAINTENANCE_FREEZE
  const freezeOn = await fetch(`${baseUrl}/api/admin/maintenance-freeze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ frozen: true, reason: 'اختبار التجميد' }),
  });
  assert.equal(freezeOn.status, 200);

  const frozenWrites = await Promise.all([
    fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'زبون مجمّد',
        exactLocation: 'ديالى - بعقوبة',
        birthDate: '1999-01-01',
        phone: '07700000051',
        items: [{ productId: 'p-101', selectedSize: '100 مل', quantity: 1 }],
      }),
    }),
    fetch(`${baseUrl}/api/custom-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        perfumeName: 'عطر مجمّد',
        expectedPriceIqd: 25000,
        size: '100 مل',
        desiredDate: '2026-12-01',
        customerName: 'فهد',
        customerPhone: '07700000052',
      }),
    }),
    fetch(`${baseUrl}/api/admin/upload-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ dataUrl: `data:image/png;base64,${pngBase64}` }),
    }),
    fetch(`${baseUrl}/api/admin/promo-codes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        code: 'FROZEN10',
        ownerName: 'مختبر',
        discountType: 'percent',
        discountValue: 10,
      }),
    }),
    fetch(`${baseUrl}/api/admin/sync-catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    }),
    fetch(`${baseUrl}/api/admin/save-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    }),
    fetch(`${baseUrl}/api/admin/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code: 'M99', name: 'عطر', priceIqd: 20000 }),
    }),
  ]);

  for (const res of frozenWrites) {
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'MAINTENANCE_FREEZE');
  }

  // Reads and state export continue working while frozen
  const stillTrackable = await fetch(
    `${baseUrl}/api/orders/track?orderNumber=BG-1001&phone=07700000050`
  );
  assert.equal(stillTrackable.status, 200);

  const exportRes = await fetch(`${baseUrl}/api/admin/export-state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(exportRes.status, 200);
  const exportJson = (await exportRes.json()) as {
    data: { orders: unknown[]; writeFreeze: boolean };
    integrity: { dataSectionSha256: string };
  };
  assert.equal(exportJson.data.orders.length, 1);
  assert.equal(exportJson.data.writeFreeze, true);
  assert.ok(exportJson.integrity.dataSectionSha256.length === 64);

  // Unfreeze restores writes
  const freezeOff = await fetch(`${baseUrl}/api/admin/maintenance-freeze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ frozen: false }),
  });
  assert.equal(freezeOff.status, 200);

  const afterUnfreeze = await fetch(`${baseUrl}/api/custom-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      perfumeName: 'عطر بعد فك التجميد',
      expectedPriceIqd: 35000,
      size: '100 مل',
      desiredDate: '2026-12-01',
      customerName: 'ندى',
      customerPhone: '07700000053',
    }),
  });
  assert.equal(afterUnfreeze.status, 201);
});

test('STRICT_NO_LOCAL_WRITES rejects writes with 503 when Turso is not configured', async (t) => {
  const { baseUrl } = await startTestServer(t, {
    turso: null,
    strictNoLocalWrites: true,
  });

  const healthRes = await fetch(`${baseUrl}/api/health`);
  const health = (await healthRes.json()) as { storageEngine: string; strictNoLocalWrites: boolean };
  assert.equal(health.storageEngine, 'read-only-disabled');
  assert.equal(health.strictNoLocalWrites, true);

  const orderRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'محاولة محلية',
      exactLocation: 'ديالى - بعقوبة',
      birthDate: '1999-01-01',
      phone: '07700000060',
      items: [{ productId: 'p-101', selectedSize: '100 مل', quantity: 1 }],
    }),
  });
  assert.equal(orderRes.status, 503);
  const body = (await orderRes.json()) as { code: string };
  assert.equal(body.code, 'STRICT_NO_LOCAL_WRITES');
});

test('Sliding-window rate limiter enforces 429 RATE_LIMITED on excessive auth and write attempts', async (t) => {
  const { baseUrl } = await startTestServer(t, {
    rateLimitMaxAuth: 3,
    rateLimitMaxWrites: 3,
  });

  for (let i = 0; i < 3; i += 1) {
    const r = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'wrong' }),
    });
    assert.equal(r.status, 401);
  }
  const fourthAuth = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'wrong' }),
  });
  assert.equal(fourthAuth.status, 429);
  const authLimitBody = (await fourthAuth.json()) as { code: string };
  assert.equal(authLimitBody.code, 'RATE_LIMITED');
});
