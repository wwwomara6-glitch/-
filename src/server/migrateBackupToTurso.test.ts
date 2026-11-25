import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  importBackupToTurso,
  reconcileCutoverSnapshots,
  validateBackupEnvelope,
  type ProductionBackupEnvelope,
} from './migrateBackupToTurso.ts';
import { TursoStore, sha256Hex } from './tursoStore.ts';
import type { Order } from '../utils/commerce.ts';

function buildSyntheticOrder(overrides: Partial<Order> = {}): Order {
  const phone = overrides.phone ?? '07700000010';
  return {
    id: overrides.id ?? 'ord-test-1',
    orderNumber: overrides.orderNumber ?? 'BG-1042',
    createdAt: overrides.createdAt ?? '2026-11-20T10:00:00.000Z',
    fullName: overrides.fullName ?? 'زبون تجريبي',
    exactLocation: overrides.exactLocation ?? 'ديالى - بعقوبة',
    birthDate: overrides.birthDate ?? '1995-01-01',
    phone,
    items: overrides.items ?? [
      {
        productId: 'bl-1',
        code: 'M01',
        name: 'عطر تجريبي',
        brand: 'بلوكرانا',
        category: 'blaugrana',
        size: '100 مل',
        priceIqd: 30000,
        quantity: 2,
        includesFreeTester: true,
      },
    ],
    pricing: overrides.pricing ?? {
      totalItemsCount: 2,
      qualifyingPerfumeUnits: 2,
      freeTestersCount: 2,
      freePerfumeUnitsEarned: 0,
      loyaltyDiscountIqd: 0,
      promoDiscountIqd: 0,
      rawSubtotalIqd: 60000,
      subtotalAfterDiscountIqd: 60000,
      deliveryFeeIqd: 0,
      qualifiesForFreeDelivery: true,
      amountToFreeDeliveryIqd: 0,
      totalIqd: 60000,
      priorPerfumeUnits: 0,
      stampsBefore: 0,
      stampsAfter: 2,
      stampsNeededForNextFree: 3,
    },
    voucherCode: overrides.voucherCode ?? 'BG-VIP-0010',
    status: overrides.status ?? 'تم الاستلام',
    estimatedArrival: overrides.estimatedArrival ?? 'خلال 24 ساعة',
    statusMessage: overrides.statusMessage ?? 'تم استلام طلبك',
    statusHistory: overrides.statusHistory ?? [
      { status: 'تم الاستلام', timestamp: '2026-11-20T10:00:00.000Z' },
    ],
  };
}

function signEnvelope(
  data: NonNullable<ProductionBackupEnvelope['data']>
): ProductionBackupEnvelope {
  const dataSectionSha256 = sha256Hex(JSON.stringify(data));
  const envelope: ProductionBackupEnvelope = {
    schemaVersion: 4,
    exportedAt: '2026-11-25T00:00:00.000Z',
    origin: 'https://synthetic-staging.test',
    data,
    integrity: {
      dataSectionSha256,
      hashAlgorithm: 'SHA-256',
    },
  };
  const fileSha256 = sha256Hex(JSON.stringify(envelope));
  envelope.integrity!.fileSha256 = fileSha256;
  return envelope;
}

function createTempStore(t: test.TestContext): TursoStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-migrate-test-'));
  const store = new TursoStore({
    url: `file:${path.join(dir, 'migrate.sqlite')}`,
    isTestMode: true,
  });
  t.after(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test('validateBackupEnvelope rejects tampered SHA-256, missing loyalty fields, and failedPhones', () => {
  const clean = signEnvelope({
    orders: [buildSyntheticOrder()],
    customRequests: [],
    notifications: [],
    promoCodes: [],
    loyaltyProfiles: {
      profilesWithActivity: [
        {
          phone: '07700000010',
          totalQualifyingPerfumes: 2,
          stamps: 2,
          stampsRemainingForFree: 3,
          freePerfumesRedeemed: 0,
          voucherCode: 'BG-VIP-0010',
          ordersCount: 1,
        },
      ],
      indistinguishableZeroProfiles: [],
      failedPhones: [],
    },
    orderSequenceEstimate: 1020,
    loyaltyCountReportedByDashboard: 4,
  });

  assert.equal(validateBackupEnvelope(clean).valid, true);

  // Tamper without updating SHA-256
  const tampered = structuredClone(clean);
  tampered.data!.orders![0].pricing.totalIqd = 999999;
  const tamperedRes = validateBackupEnvelope(tampered);
  assert.equal(tamperedRes.valid, false);
  assert.ok(tamperedRes.errors.some((e) => e.includes('dataSectionSha256')));

  // Missing loyalty 7th field + failedPhones
  const brokenLoyalty = signEnvelope({
    orders: [],
    customRequests: [],
    notifications: [],
    promoCodes: [],
    loyaltyProfiles: {
      profilesWithActivity: [
        { phone: '07700000010', totalQualifyingPerfumes: 1 } as never,
      ],
      indistinguishableZeroProfiles: [],
      failedPhones: ['07700000099'],
    },
  });
  const brokenRes = validateBackupEnvelope(brokenLoyalty);
  assert.equal(brokenRes.valid, false);
  assert.ok(brokenRes.errors.some((e) => e.includes('failedPhones') || e.includes('هواتف فاشلة')));
  assert.ok(brokenRes.errors.some((e) => e.includes('ordersCount')));
});

test('importBackupToTurso preserves activity/zero loyalty, computes safe orderSequence, documents unrecoverable gaps, and is idempotent', async (t) => {
  const store = createTempStore(t);

  const envelope = signEnvelope({
    orders: [buildSyntheticOrder({ id: 'ord-a', orderNumber: 'BG-1042', phone: '07700000010' })],
    customRequests: [
      {
        id: 'creq-1',
        createdAt: '2026-11-21T12:00:00.000Z',
        perfumeName: 'عطر مفقود',
        expectedPriceIqd: 50000,
        size: '100 مل',
        desiredDate: '2026-12-01',
        customerName: 'ندى',
        customerPhone: '07700000011',
        notes: 'ملاحظة',
        status: 'قيد البحث',
      },
    ],
    notifications: [
      {
        id: 'notif-1',
        createdAt: '2026-11-20T10:00:00.000Z',
        type: 'new_order',
        orderId: 'ord-a',
        orderNumber: 'BG-1042',
        customerName: 'زبون تجريبي',
        customerPhone: '07700000010',
        totalIqd: 60000,
        itemsSummary: '#M01 عطر تجريبي × 2',
        message: 'تنبيه',
        read: false,
      },
    ],
    promoCodes: [
      {
        id: 'pr-1',
        code: 'BLAU15',
        ownerName: 'كريم',
        discountType: 'percent',
        discountValue: 15,
        durationDays: null,
        expiresAt: null,
        active: true,
        timesUsed: 3,
        createdAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    loyaltyProfiles: {
      profilesWithActivity: [
        {
          phone: '07700000010',
          totalQualifyingPerfumes: 2,
          stamps: 2,
          stampsRemainingForFree: 3,
          freePerfumesRedeemed: 0,
          voucherCode: 'BG-VIP-0010',
          ordersCount: 1,
        },
      ],
      indistinguishableZeroProfiles: [
        {
          phone: '07700000011',
          totalQualifyingPerfumes: 0,
          stamps: 0,
          stampsRemainingForFree: 5,
          freePerfumesRedeemed: 0,
          voucherCode: 'BG-VIP-0011',
          ordersCount: 0,
        },
      ],
      failedPhones: [],
    },
    orderSequenceEstimate: 1020,
    loyaltyCountReportedByDashboard: 7,
  });

  const firstImport = await importBackupToTurso(store, envelope, {
    snapshotType: 'snapshot_1_staging',
  });
  assert.equal(firstImport.ok, true);
  assert.equal(firstImport.importedCounts.ordersInserted, 1);
  assert.equal(firstImport.importedCounts.customRequestsInserted, 1);
  assert.equal(firstImport.importedCounts.notificationsInserted, 1);
  assert.equal(firstImport.importedCounts.promoCodesInserted, 1);
  assert.equal(firstImport.importedCounts.loyaltyProfilesWithActivityUpserted, 1);
  assert.equal(firstImport.importedCounts.loyaltyIndistinguishableZeroUpserted, 1);
  assert.equal(firstImport.importedCounts.totalLoyaltyInDb, 2);
  assert.equal(firstImport.crossCheckMismatches.length, 0);

  // Max BG-1042 + 1 = 1043 (> estimate 1020)
  assert.equal(await store.getOrderSequence(), 1043);

  // Mandatory documented gaps (never falsely claimed complete/exact)
  assert.equal(firstImport.audit.orderSequenceExactnessProven, false);
  assert.equal(firstImport.audit.loyaltyCompletenessProven, false);
  assert.equal(firstImport.audit.orderSequenceSource, 'estimated_from_orders');
  assert.equal(firstImport.audit.reportedOldLoyaltyCount, 7);
  assert.equal(firstImport.audit.extractedProfilesWithActivityCount, 1);
  assert.equal(firstImport.audit.extractedIndistinguishableZeroCount, 1);

  const savedAudit = await store.getMigrationAudit();
  assert.equal(savedAudit?.orderSequenceAssigned, 1043);
  assert.equal(savedAudit?.loyaltyCompletenessProven, false);

  // Idempotent second import inserts zero duplicates
  const secondImport = await importBackupToTurso(store, envelope, {
    snapshotType: 'snapshot_2_cutover',
  });
  assert.equal(secondImport.importedCounts.ordersInserted, 0);
  assert.equal(secondImport.importedCounts.customRequestsInserted, 0);
  assert.equal(secondImport.importedCounts.notificationsInserted, 0);
  assert.equal(secondImport.importedCounts.promoCodesInserted, 0);
  assert.equal(secondImport.importedCounts.totalOrdersInDb, 1);
  assert.equal(secondImport.importedCounts.totalLoyaltyInDb, 2);
});

test('validateBackupEnvelope flags order-vs-loyalty mismatches and reconcileCutoverSnapshots isolates exact cutover delta', () => {
  const baseOrder = buildSyntheticOrder({ id: 'ord-1', orderNumber: 'BG-1010', phone: '07700000020' });
  const base = signEnvelope({
    orders: [baseOrder],
    customRequests: [],
    notifications: [],
    promoCodes: [],
    loyaltyProfiles: {
      profilesWithActivity: [
        {
          phone: '07700000020',
          totalQualifyingPerfumes: 99, // intentional mismatch vs 2 in order
          stamps: 4,
          stampsRemainingForFree: 1,
          freePerfumesRedeemed: 0,
          voucherCode: 'BG-VIP-0020',
          ordersCount: 1,
        },
      ],
      indistinguishableZeroProfiles: [],
      failedPhones: [],
    },
  });

  const baseCheck = validateBackupEnvelope(base);
  assert.equal(baseCheck.valid, true);
  assert.equal(baseCheck.normalized?.crossCheckMismatches.length, 1);
  assert.equal(baseCheck.normalized?.crossCheckMismatches[0].phone, '07700000020');

  // Same snapshot -> no reconciliation needed
  const noDelta = reconcileCutoverSnapshots(base, base);
  assert.equal(noDelta.requiresSecondImport, false);
  assert.equal(noDelta.newOrders.length, 0);

  // Cutover snapshot captured after 1 late order during cutover window
  const lateOrder = buildSyntheticOrder({
    id: 'ord-2-late',
    orderNumber: 'BG-1011',
    phone: '07700000021',
  });
  const latest = signEnvelope({
    orders: [baseOrder, lateOrder],
    customRequests: [
      {
        id: 'creq-late',
        createdAt: '2026-11-25T02:00:00.000Z',
        perfumeName: 'عطر متأخر',
        expectedPriceIqd: 30000,
        size: '50 مل',
        desiredDate: '2026-12-10',
        customerName: 'فهد',
        customerPhone: '07700000022',
        notes: '',
        status: 'قيد البحث',
      },
    ],
    notifications: [],
    promoCodes: [],
    loyaltyProfiles: {
      profilesWithActivity: base.data!.loyaltyProfiles!.profilesWithActivity!,
      indistinguishableZeroProfiles: [],
      failedPhones: [],
    },
  });

  const delta = reconcileCutoverSnapshots(base, latest);
  assert.equal(delta.requiresSecondImport, true);
  assert.deepEqual(
    delta.newOrders.map((o) => o.orderNumber),
    ['BG-1011']
  );
  assert.deepEqual(
    delta.newCustomRequests.map((r) => r.id),
    ['creq-late']
  );
});
