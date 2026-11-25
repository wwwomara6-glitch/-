import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { User } from 'firebase/auth';
import {
  BACKUP_SCHEMA_VERSION,
  canonicalJsonStringify,
  computeCatalogBackupChecksumSha256,
  executeCatalogBackupRestore,
  exportLiveCatalogBackupFromFirestore,
  MAX_BACKUP_FILE_BYTES,
  parseAndValidateBackupFile,
  previewBackupRestoreDiff,
  type BackupAuditRecord,
  type FirestoreBackupAdapter,
} from './firestoreBackup';
import {
  buildCatalogSyncCommitPlan,
  type FirestoreSyncAdapter,
  type FirestoreSyncBatchOp,
} from './firestoreCatalogSync';
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

function loadPreMigrationBackupText(): string {
  const backupPath = path.resolve(
    process.cwd(),
    'backups/pre-migration/blaugrana-db-backup.json'
  );
  return fs.readFileSync(backupPath, 'utf8');
}

function createMockBackupEnvironment(
  initialProducts: Product[],
  storeInfo: StoreInfo,
  socialLinks: SocialLink[],
  options: {
    version?: string;
    failAuditWrite?: boolean;
    failBatchNumber?: number;
  } = {}
): {
  adapter: FirestoreBackupAdapter;
  store: Map<string, Record<string, unknown>>;
  audits: Map<string, BackupAuditRecord>;
  committedBatches: FirestoreSyncBatchOp[][];
  getReadCount: () => number;
  resetReadCount: () => void;
} {
  const store = new Map<string, Record<string, unknown>>();
  const audits = new Map<string, BackupAuditRecord>();
  const committedBatches: FirestoreSyncBatchOp[][] = [];
  let readCount = 0;
  let commitCallCount = 0;

  const initialPlan = buildCatalogSyncCommitPlan({
    products: initialProducts,
    storeInfo,
    socialLinks,
    previousChunkIds: [],
    changedProductIds: initialProducts.map((p) => p.id),
    version: options.version ?? 'v1.1795519949113',
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

  const syncAdapter: FirestoreSyncAdapter = {
    async getDocFromServer(col, id) {
      readCount += 1;
      const key = `${col}/${id}`;
      return {
        exists: store.has(key),
        data: store.has(key) ? structuredClone(store.get(key)) : undefined,
      };
    },
    async commitBatch(ops) {
      commitCallCount += 1;
      if (
        options.failBatchNumber &&
        commitCallCount === options.failBatchNumber
      ) {
        throw new Error('Simulated Firestore network timeout on batch commit');
      }
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

  const adapter: FirestoreBackupAdapter = {
    syncAdapter,
    async recordBackupAudit(record) {
      if (options.failAuditWrite) {
        throw new Error('Simulated audit permission failure');
      }
      // Enforce deployed firestore.rules isValidBackupRecord() contract
      assert.match(record.id, /^[a-zA-Z0-9_\-]{1,128}$/);
      assert.equal(record.createdBy, 'wwwomara6@gmail.com');
      assert.ok(Number.isInteger(record.productCount) && record.productCount >= 0);
      assert.match(record.checksumSha256, /^[a-f0-9]{64}$/);
      if (record.summary !== undefined) {
        assert.ok(record.summary.length <= 400);
      }
      audits.set(record.id, structuredClone(record));
    },
    async listBackupAudits(limitCount = 10) {
      return Array.from(audits.values())
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limitCount);
    },
  };

  return {
    adapter,
    store,
    audits,
    committedBatches,
    getReadCount: () => readCount,
    resetReadCount: () => {
      readCount = 0;
    },
  };
}

const VERIFIED_OWNER = {
  uid: 'owner-uid',
  email: 'wwwomara6@gmail.com',
  emailVerified: true,
} as unknown as User;

const UNAUTHORIZED_USER = {
  uid: 'intruder-uid',
  email: 'intruder@example.com',
  emailVerified: true,
} as unknown as User;

test('Phase 2 Export: Exports 229 products with canonical SHA-256 in 3 Spark reads and valid backups/{id} audit', async () => {
  const fixture = load229Fixture();
  assert.equal(fixture.products.length, 229);

  const env = createMockBackupEnvironment(
    fixture.products,
    fixture.storeInfo,
    fixture.socialLinks
  );

  const result = await exportLiveCatalogBackupFromFirestore({
    user: VERIFIED_OWNER,
    adapter: env.adapter,
    nowMs: 1795520000000,
  });

  // Strict Spark free-tier read budget: 1 catalog_meta + 2 chunks = 3 reads
  assert.equal(result.readsUsed, 3);
  assert.equal(env.getReadCount(), 3);

  // Zero mutations to products/chunks/meta
  assert.equal(env.committedBatches.length, 0);

  // Full completeness & zero sensitive data leakage
  assert.equal(result.backup.schemaVersion, BACKUP_SCHEMA_VERSION);
  assert.equal(result.backup.counts.productsCount, 229);
  assert.equal(result.backup.data.products.length, 229);
  assert.equal(
    result.backup.counts.socialLinksCount,
    fixture.socialLinks.length
  );
  assert.match(result.backup.checksumSha256, /^[a-f0-9]{64}$/);
  assert.ok(!result.auditWarning);
  assert.ok(!result.countMismatchWarning);

  const serializedKeys = Object.keys(result.backup.data);
  assert.deepEqual(serializedKeys.sort(), ['products', 'socialLinks', 'storeInfo']);

  // Audit record persisted cleanly
  assert.ok(result.auditRecord);
  assert.equal(env.audits.size, 1);
  assert.equal(
    result.auditRecord?.checksumSha256,
    result.backup.checksumSha256
  );

  // Recomputing SHA-256 independently matches
  const recomputed = await computeCatalogBackupChecksumSha256(result.backup.data);
  assert.equal(recomputed, result.backup.checksumSha256);
});

test('Phase 2 Validation: Rejects tampered SHA-256, corrupted JSON, duplicate IDs, and firestore.rules violations; accepts legacy backup', async () => {
  const fixture = load229Fixture();
  const env = createMockBackupEnvironment(
    fixture.products,
    fixture.storeInfo,
    fixture.socialLinks
  );
  const exported = await exportLiveCatalogBackupFromFirestore({
    user: VERIFIED_OWNER,
    adapter: env.adapter,
    nowMs: 1795520001000,
  });

  // 1) Corrupted / empty / oversized JSON
  const emptyCheck = await parseAndValidateBackupFile('   ');
  assert.equal(emptyCheck.valid, false);

  const badJsonCheck = await parseAndValidateBackupFile('{bad json');
  assert.equal(badJsonCheck.valid, false);

  const oversizedCheck = await parseAndValidateBackupFile(
    'a'.repeat(MAX_BACKUP_FILE_BYTES + 10)
  );
  assert.equal(oversizedCheck.valid, false);

  // 2) Tampered 1 price inside v2 backup breaks SHA-256 verification
  const tampered = structuredClone(exported.backup);
  tampered.data.products[0].priceIqd += 1000;
  const tamperedCheck = await parseAndValidateBackupFile(JSON.stringify(tampered));
  assert.equal(tamperedCheck.valid, false);
  assert.equal(tamperedCheck.checksumVerified, false);
  assert.match(tamperedCheck.errors[0] ?? '', /SHA-256/);

  // 3) Duplicate ID rejection
  const dupBackup = structuredClone(exported.backup);
  dupBackup.data.products.push(structuredClone(dupBackup.data.products[0]));
  dupBackup.checksumSha256 = await computeCatalogBackupChecksumSha256(dupBackup.data);
  const dupCheck = await parseAndValidateBackupFile(JSON.stringify(dupBackup));
  assert.equal(dupCheck.valid, false);
  assert.match(dupCheck.errors[0] ?? '', /تكرار معرّف المنتج/);

  // 4) Invalid Base64 image & low price rejection against firestore.rules
  const badRuleBackup = structuredClone(exported.backup);
  delete badRuleBackup.data.products[0].sizePrices;
  badRuleBackup.data.products[0].priceIqd = 100;
  badRuleBackup.data.products[1].imageUrl = 'data:image/png;base64,AAAA';
  badRuleBackup.checksumSha256 = await computeCatalogBackupChecksumSha256(
    badRuleBackup.data
  );
  const badRuleCheck = await parseAndValidateBackupFile(
    JSON.stringify(badRuleBackup)
  );
  assert.equal(badRuleCheck.valid, false);
  assert.equal(badRuleCheck.errors.length, 2);

  // 5) Genuine legacy backup (`backups/pre-migration/blaugrana-db-backup.json`) parses validly with warning
  const legacyText = loadPreMigrationBackupText();
  const legacyCheck = await parseAndValidateBackupFile(legacyText);
  assert.equal(legacyCheck.valid, true);
  assert.equal(legacyCheck.sourceFormat, 'legacy-db-json');
  assert.equal(legacyCheck.products.length, 229);
  assert.equal(legacyCheck.checksumVerified, false);
  assert.ok(legacyCheck.warnings.length >= 1);
});

test('Phase 2 Round-Trip & Default Merge: Restores deleted/edited items with exact original IDs while preserving live-only products and skipping unchanged writes', async () => {
  const fixture = load229Fixture();
  const initialEnv = createMockBackupEnvironment(
    fixture.products,
    fixture.storeInfo,
    fixture.socialLinks
  );

  const exported = await exportLiveCatalogBackupFromFirestore({
    user: VERIFIED_OWNER,
    adapter: initialEnv.adapter,
    nowMs: 1795520002000,
  });

  const validated = await parseAndValidateBackupFile(
    JSON.stringify(exported.backup)
  );
  assert.equal(validated.valid, true);
  assert.equal(validated.checksumVerified, true);

  // Mutate live state: delete 1st product, edit 2nd product's price & image, add #230 live-only product
  const deletedProduct = fixture.products[0];
  const editedProductOrig = fixture.products[1];
  const editedLiveProduct: Product = {
    ...editedProductOrig,
    priceIqd: editedProductOrig.priceIqd + 9000,
    inStock: false,
    imageUrl: 'https://cdn.example.com/mutated-live.jpg',
  };
  const liveOnly230: Product = {
    ...fixture.products[0],
    id: 'bl-live-230',
    code: '999',
    name: 'عطر مضاف حياً 230',
  };

  const mutatedProducts = [
    editedLiveProduct,
    ...fixture.products.slice(2),
    liveOnly230,
  ];
  const liveEnv = createMockBackupEnvironment(
    mutatedProducts,
    fixture.storeInfo,
    fixture.socialLinks,
    { version: 'v1.1795520009000' }
  );
  // Copy audit record so preview verifies matchedAuditRecord too
  if (exported.auditRecord) {
    liveEnv.audits.set(exported.auditRecord.id, exported.auditRecord);
  }

  liveEnv.resetReadCount();
  const preview = await previewBackupRestoreDiff(validated, {
    user: VERIFIED_OWNER,
    adapter: liveEnv.adapter,
  });

  assert.equal(preview.toAdd.length, 1);
  assert.equal(preview.toAdd[0].id, deletedProduct.id);
  assert.equal(preview.toUpdate.length, 1);
  assert.equal(preview.toUpdate[0].id, editedProductOrig.id);
  assert.equal(preview.unchangedCount, 227);
  assert.equal(preview.liveOnlyProducts.length, 1);
  assert.equal(preview.liveOnlyProducts[0].id, 'bl-live-230');
  assert.ok(preview.matchedAuditRecord);
  assert.equal(preview.mergeModePlanSummary.resultProductCount, 230);
  // Zero writes during preview
  assert.equal(liveEnv.committedBatches.length, 0);

  // Execute default restore (`merge_preserve_live` implicit default)
  const restoreRes = await executeCatalogBackupRestore(validated, {
    user: VERIFIED_OWNER,
    adapter: liveEnv.adapter,
    skipCacheInvalidation: true,
    nowMs: 1795520020000,
  });

  assert.equal(restoreRes.mode, 'merge_preserve_live');
  assert.equal(restoreRes.restoredProductCount, 230);
  assert.equal(restoreRes.addedCount, 1);
  assert.equal(restoreRes.updatedCount, 1);
  assert.equal(restoreRes.deletedCount, 0);
  assert.equal(restoreRes.preservedLiveOnlyCount, 1);
  assert.equal(restoreRes.batchesCommitted, 1);

  // Spark optimization check: ONLY changed products written (2 products + 2 chunks + 1 meta = 5 ops total!)
  assert.equal(liveEnv.committedBatches[0].length, 5);

  // Exact original product ID and prices/images preserved cleanly
  const restoredEdited = liveEnv.store.get(`products/${editedProductOrig.id}`) as
    | Product
    | undefined;
  assert.ok(restoredEdited);
  assert.equal(restoredEdited.priceIqd, editedProductOrig.priceIqd);
  assert.equal(restoredEdited.imageUrl, editedProductOrig.imageUrl);
  assert.equal(restoredEdited.inStock, editedProductOrig.inStock);

  const restoredDeleted = liveEnv.store.get(`products/${deletedProduct.id}`) as
    | Product
    | undefined;
  assert.ok(restoredDeleted);
  assert.equal(restoredDeleted.id, deletedProduct.id);

  // Live-only product #230 still exists in both products/ & chunks
  assert.ok(liveEnv.store.has('products/bl-live-230'));
  assert.equal(
    (liveEnv.store.get('catalog_meta/public') as { productCount: number })
      .productCount,
    230
  );
});

test('Phase 2 Exact Mirror Guard: Requires explicit confirmExactMirror & count match, deletes live-only products and stale chunks cleanly', async () => {
  const fixture = load229Fixture();
  const envBase = createMockBackupEnvironment(
    fixture.products,
    fixture.storeInfo,
    fixture.socialLinks
  );
  const exported = await exportLiveCatalogBackupFromFirestore({
    user: VERIFIED_OWNER,
    adapter: envBase.adapter,
    nowMs: 1795520030000,
  });
  const validated = await parseAndValidateBackupFile(
    JSON.stringify(exported.backup)
  );
  assert.equal(validated.valid, true);

  // Expand live state to 245 products so live uses 3 chunks (chunk_0, chunk_1, chunk_2)
  const extraProducts: Product[] = Array.from({ length: 16 }, (_, idx) => ({
    ...fixture.products[0],
    id: `extra-live-${idx + 1}`,
    code: `90${idx}`,
    name: `عطر إضافي ${idx + 1}`,
  }));
  const liveEnv = createMockBackupEnvironment(
    [...fixture.products, ...extraProducts],
    fixture.storeInfo,
    fixture.socialLinks,
    { version: 'v1.1795520040000' }
  );
  assert.ok(liveEnv.store.has('catalog_chunks/chunk_2'));

  // 1) Guard rejects exact_mirror without confirmExactMirror === true
  await assert.rejects(
    () =>
      executeCatalogBackupRestore(validated, {
        user: VERIFIED_OWNER,
        adapter: liveEnv.adapter,
        mode: 'exact_mirror',
        skipCacheInvalidation: true,
      }),
    /مربع التأكيد الصريح/
  );
  assert.equal(liveEnv.committedBatches.length, 0);

  // 2) Guard rejects stale diff count mismatch
  await assert.rejects(
    () =>
      executeCatalogBackupRestore(validated, {
        user: VERIFIED_OWNER,
        adapter: liveEnv.adapter,
        mode: 'exact_mirror',
        confirmExactMirror: true,
        expectedDeleteCount: 99,
        skipCacheInvalidation: true,
      }),
    /تغيّرت البيانات الحية/
  );

  // 3) Confirmed exact_mirror deletes all 16 extra products + stale chunk_2, leaving exact 229
  const mirrorRes = await executeCatalogBackupRestore(validated, {
    user: VERIFIED_OWNER,
    adapter: liveEnv.adapter,
    mode: 'exact_mirror',
    confirmExactMirror: true,
    expectedDeleteCount: 16,
    skipCacheInvalidation: true,
    nowMs: 1795520050000,
  });

  assert.equal(mirrorRes.mode, 'exact_mirror');
  assert.equal(mirrorRes.restoredProductCount, 229);
  assert.equal(mirrorRes.deletedCount, 16);
  assert.deepEqual(mirrorRes.staleChunksDeleted, ['chunk_2']);
  assert.deepEqual(mirrorRes.chunkIds, ['chunk_0', 'chunk_1']);
  assert.equal(liveEnv.store.has('catalog_chunks/chunk_2'), false);
  assert.equal(liveEnv.store.has('products/extra-live-1'), false);
  assert.equal(
    (liveEnv.store.get('catalog_meta/public') as { productCount: number })
      .productCount,
    229
  );
});

test('Phase 2 Security & Fault Isolation: Blocks unauthorized owner, survives audit failure on export, and preserves live meta on batch failure', async () => {
  const fixture = load229Fixture();

  // 1) Reject non-owner across export, preview, and restore
  const unauthEnv = createMockBackupEnvironment(
    fixture.products,
    fixture.storeInfo,
    fixture.socialLinks
  );
  await assert.rejects(
    () =>
      exportLiveCatalogBackupFromFirestore({
        user: UNAUTHORIZED_USER,
        adapter: unauthEnv.adapter,
      }),
    /غير مصرّح بالتصدير/
  );
  assert.equal(unauthEnv.getReadCount(), 0);

  // 2) Audit write error during export is non-fatal (returns auditWarning instead of throwing)
  const auditFailEnv = createMockBackupEnvironment(
    fixture.products,
    fixture.storeInfo,
    fixture.socialLinks,
    { failAuditWrite: true }
  );
  const exportWithWarn = await exportLiveCatalogBackupFromFirestore({
    user: VERIFIED_OWNER,
    adapter: auditFailEnv.adapter,
    nowMs: 1795520060000,
  });
  assert.equal(exportWithWarn.backup.data.products.length, 229);
  assert.equal(exportWithWarn.auditRecord, null);
  assert.ok(exportWithWarn.auditWarning);

  // 3) Mid-flight batch failure during large restore (>400 ops) leaves catalog_meta/public untouched
  const emptyLiveEnv = createMockBackupEnvironment(
    [fixture.products[0]],
    fixture.storeInfo,
    fixture.socialLinks,
    { version: 'v1.initial-safe', failBatchNumber: 2 }
  );

  // Build 420 valid products so restore splits into 2 batches (420 products in batch 1, barrier chunks+meta in batch 2)
  const bigProducts: Product[] = Array.from({ length: 420 }, (_, i) => ({
    ...fixture.products[0],
    id: `big-p-${i + 1}`,
    code: `${1000 + i}`,
    name: `عطر اختبار ${i + 1}`,
  }));
  const bigPayload = {
    storeInfo: fixture.storeInfo,
    socialLinks: fixture.socialLinks,
    products: bigProducts,
  };
  const bigJson = JSON.stringify({
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: '2026-11-24T12:00:00.000Z',
    exportedBy: 'wwwomara6@gmail.com',
    source: {
      projectId: 'test',
      databaseId: 'test',
      catalogVersion: 'v1.big',
      catalogUpdatedAt: '2026-11-24T12:00:00.000Z',
      chunkIds: ['chunk_0', 'chunk_1', 'chunk_2', 'chunk_3'],
    },
    checksumSha256: await computeCatalogBackupChecksumSha256(bigPayload),
    counts: { productsCount: 420, socialLinksCount: 3, categoryBreakdown: { blaugrana: 420 } },
    data: bigPayload,
  });
  const bigValidated = await parseAndValidateBackupFile(bigJson);
  assert.equal(bigValidated.valid, true);

  await assert.rejects(
    () =>
      executeCatalogBackupRestore(bigValidated, {
        user: VERIFIED_OWNER,
        adapter: emptyLiveEnv.adapter,
        skipCacheInvalidation: true,
      }),
    /Simulated Firestore network timeout/
  );

  // Because barrier batch failed before committing, customers still see v1.initial-safe cleanly!
  assert.equal(
    (emptyLiveEnv.store.get('catalog_meta/public') as { version: string }).version,
    'v1.initial-safe'
  );
  assert.equal(
    canonicalJsonStringify({ b: 2, a: 1 }),
    canonicalJsonStringify({ a: 1, b: 2 })
  );
});
