import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { User } from 'firebase/auth';
import {
  buildCatalogMigrationPlan,
  EXCLUDED_SENSITIVE_FIELDS,
  executeSafeCatalogMigrationWithWriteBatch,
  FIRESTORE_DOC_LIMIT_BYTES,
  inspectExistingMigrationDocs,
  verifyMigratedCatalogInFirestore,
  type MigrationBatchAdapter,
  type RawMigrationDatabaseInput,
} from './catalogMigration';

function readSourceDb(): RawMigrationDatabaseInput {
  const dbPath = path.resolve(process.cwd(), 'data/blaugrana-db.json');
  return JSON.parse(fs.readFileSync(dbPath, 'utf8')) as RawMigrationDatabaseInput;
}

test('Stage 4 Dry-Run: builds 229 products, 2 chunks, and catalog_meta/public within 1 MiB with zero issues', () => {
  const rawDb = readSourceDb();
  const plan = buildCatalogMigrationPlan(rawDb, {
    version: 'v1.0.0-initial',
    generatedAt: '2026-11-23T22:00:00.000Z',
  });

  assert.equal(plan.dryRunOnly, true);
  assert.equal(plan.readyForExecution, true);
  assert.equal(plan.issues.length, 0);
  assert.equal(plan.includedDataSummary.productsCount, 229);
  assert.equal(plan.productDocs.length, 229);
  assert.equal(plan.chunkDocs.length, 2);
  assert.equal(plan.chunkDocs[0].chunkId, 'chunk_0');
  assert.equal(plan.chunkDocs[0].data.items.length, 120);
  assert.equal(plan.chunkDocs[1].chunkId, 'chunk_1');
  assert.equal(plan.chunkDocs[1].data.items.length, 109);
  assert.equal(plan.metaDoc.productCount, 229);
  assert.deepEqual(plan.metaDoc.chunkIds, ['chunk_0', 'chunk_1']);
  assert.equal(plan.totalFirestoreWritesPlanned, 232);

  // Verify Firestore 1 MiB document size bounds
  assert.equal(plan.documentSizes.allWithin1MiBLimit, true);
  assert.ok(plan.documentSizes.meta.estimatedFirestoreBytes < FIRESTORE_DOC_LIMIT_BYTES);
  for (const c of plan.documentSizes.chunks) {
    assert.ok(c.estimatedFirestoreBytes < FIRESTORE_DOC_LIMIT_BYTES);
    assert.ok(c.percentOf1MiBLimit < 25, `Chunk ${c.path} unexpectedly large: ${c.percentOf1MiBLimit}%`);
  }
  assert.ok(plan.documentSizes.maxProduct.estimatedFirestoreBytes < 5000);

  // Verify NO sensitive fields leaked into meta or product payloads
  const serializedMeta = JSON.stringify(plan.metaDoc);
  const serializedChunks = JSON.stringify(plan.chunkDocs);
  for (const excludedKey of EXCLUDED_SENSITIVE_FIELDS) {
    assert.equal(serializedMeta.includes(`"${excludedKey}"`), false);
    assert.equal(serializedChunks.includes(`"${excludedKey}"`), false);
  }
});

test('Stage 4 Dry-Run: detects missing/invalid fields cleanly when fixture is corrupted', () => {
  const brokenDb: RawMigrationDatabaseInput = {
    storeInfo: { agencyName: 'x' },
    socialLinks: [],
    products: [
      {
        id: 'bad id with spaces',
        code: 'M999',
        name: 'عطر تجريبي',
        brand: 'Blaugrana',
        category: 'invalid_category',
        priceIqd: 100,
        size: '100 مل',
        notes: '',
        longevity: 'قوي',
        sillage: 'قوي',
        description: 'وصف',
        imageUrl: '',
        includesFreeTester: true,
        inStock: true,
      },
    ],
  };

  const plan = buildCatalogMigrationPlan(brokenDb);
  assert.equal(plan.readyForExecution, false);
  assert.ok(plan.issues.some((i) => i.field === 'id'));
  assert.ok(plan.issues.some((i) => i.field === 'category'));
  assert.ok(plan.issues.some((i) => i.field === 'priceIqd'));
  assert.ok(plan.issues.some((i) => i.field === 'notes'));
  assert.ok(plan.issues.some((i) => i.field === 'imageUrl'));
});

test('Stage 4 Pre-flight: rejects unauthorized/unverified users before any read or WriteBatch', async () => {
  const plan = buildCatalogMigrationPlan(readSourceDb(), {
    version: 'v1.0.0-initial',
    generatedAt: '2026-11-23T22:00:00.000Z',
  });

  let touchedAdapter = false;
  const guardAdapter: MigrationBatchAdapter = {
    async getExistingDoc() {
      touchedAdapter = true;
      return { exists: false, data: undefined };
    },
    async commitBatch() {
      touchedAdapter = true;
    },
  };

  await assert.rejects(
    executeSafeCatalogMigrationWithWriteBatch(plan, { user: null, adapter: guardAdapter }),
    /غير مصرّح/
  );
  await assert.rejects(
    executeSafeCatalogMigrationWithWriteBatch(plan, {
      user: { email: 'other@gmail.com', emailVerified: true } as User,
      adapter: guardAdapter,
    }),
    /غير مصرّح/
  );
  await assert.rejects(
    executeSafeCatalogMigrationWithWriteBatch(plan, {
      user: { email: 'wwwomara6@gmail.com', emailVerified: false } as User,
      adapter: guardAdapter,
    }),
    /غير مصرّح/
  );
  assert.equal(touchedAdapter, false);
});

test('Stage 4 Pre-flight: WriteBatch inspects existing docs first and never overwrites them by default', async () => {
  const plan = buildCatalogMigrationPlan(readSourceDb(), {
    version: 'v1.0.0-initial',
    generatedAt: '2026-11-23T22:00:00.000Z',
  });

  const store = new Map<string, Record<string, unknown>>();
  // Pre-seed one modified product in Firestore before migration
  store.set('products/bg-m01', {
    ...plan.productDocs[0].data,
    priceIqd: 99000,
  });

  const committedBatches: number[] = [];
  const adapter: MigrationBatchAdapter = {
    async getExistingDoc(col, id) {
      const key = `${col}/${id}`;
      return {
        exists: store.has(key),
        data: store.get(key),
      };
    },
    async commitBatch(entries) {
      committedBatches.push(entries.length);
      for (const e of entries) {
        store.set(`${e.collectionName}/${e.docId}`, e.data as Record<string, unknown>);
      }
    },
  };

  const result = await executeSafeCatalogMigrationWithWriteBatch(plan, {
    user: { email: 'wwwomara6@gmail.com', emailVerified: true } as User,
    adapter,
  });

  assert.equal(result.executedByEmail, 'wwwomara6@gmail.com');
  assert.equal(result.totalPlannedDocs, 232);
  assert.equal(result.skippedExistingCount, 1);
  assert.deepEqual(result.skippedExisting, [
    { path: 'products/bg-m01', matchStatus: 'different' },
  ]);
  assert.equal(result.writtenCount, 231);
  assert.equal(result.batchesCommitted, 1);
  assert.deepEqual(committedBatches, [231]);
  // Verify existing price was NOT overwritten
  assert.equal(store.get('products/bg-m01')?.priceIqd, 99000);

  // Also test read-only pre-inspection and post-verification directly
  const ownerUser = { email: 'wwwomara6@gmail.com', emailVerified: true } as User;
  const inspection = await inspectExistingMigrationDocs(plan, {
    user: ownerUser,
    adapter,
  });
  assert.equal(inspection.totalPlannedDocs, 232);
  assert.equal(inspection.productsCount, 229);
  assert.equal(inspection.existingDocsCount, 232);
  assert.equal(inspection.toWriteCount, 0);

  const postCheck = await verifyMigratedCatalogInFirestore(plan, {
    user: ownerUser,
    adapter,
  });
  assert.equal(postCheck.metaExists, true);
  assert.equal(postCheck.metaVersion, 'v1.0.0-initial');
  assert.equal(postCheck.metaProductCount, 229);
  assert.equal(postCheck.chunkDocsVerified, 2);
  assert.equal(postCheck.chunkItemsCount, 229);
  assert.equal(postCheck.productDocsVerified, 229);
  assert.equal(postCheck.priceMismatches, 1); // reflects preserved 99000 on pre-seeded bg-m01
  assert.equal(postCheck.imageMismatches, 0);
  assert.equal(postCheck.verified, false);
});


