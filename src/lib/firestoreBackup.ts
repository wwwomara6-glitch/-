import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDocsFromServer,
  limit,
  orderBy,
  query,
  setDoc,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { FIRESTORE_DOC_LIMIT_BYTES, measureFirestoreDocumentSize } from './catalogMigration';
import {
  AUTHORIZED_ADMIN_EMAIL,
  auth,
  db,
  handleFirestoreError,
  isAuthorizedAdminUser,
  OperationType,
} from './firebase';
import { invalidateCatalogCache } from './firebaseCatalog';
import {
  buildCatalogSyncCommitPlan,
  createNextCatalogVersion,
  defaultFirestoreSyncAdapter,
  fetchAuthoritativeCatalogFromFirestore,
  sanitizeAndValidateProductForFirestore,
  sanitizeSocialLinksStrict,
  sanitizeStoreInfoStrict,
  type FirestoreSyncAdapter,
} from './firestoreCatalogSync';
import {
  compareProductsByCode,
  type Product,
  type SocialLink,
  type StoreInfo,
} from '../utils/commerce';

export const BACKUP_SCHEMA_VERSION = 'blaugrana-firestore-backup-v2' as const;
export const BACKUPS_COLLECTION = 'backups';
export const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB safety limit

const BACKUP_ID_REGEX = /^[a-zA-Z0-9_\-]{1,128}$/;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

export type RestoreMode = 'merge_preserve_live' | 'exact_mirror';

export interface BlaugranaBackupDataPayload {
  storeInfo: StoreInfo;
  socialLinks: SocialLink[];
  products: Product[];
}

export interface BlaugranaFirestoreBackupV2 {
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  exportedAt: string;
  exportedBy: string;
  source: {
    projectId: string;
    databaseId: string;
    catalogVersion: string;
    catalogUpdatedAt: string;
    chunkIds: string[];
  };
  checksumSha256: string;
  counts: {
    productsCount: number;
    socialLinksCount: number;
    categoryBreakdown: Record<string, number>;
  };
  data: BlaugranaBackupDataPayload;
}

export interface BackupAuditRecord {
  id: string;
  createdAt: string;
  createdBy: string;
  productCount: number;
  checksumSha256: string;
  summary?: string;
}

export interface BackupExportResult {
  backup: BlaugranaFirestoreBackupV2;
  filename: string;
  readsUsed: number;
  auditRecord: BackupAuditRecord | null;
  auditWarning?: string;
  countMismatchWarning?: string;
}

export interface ValidatedBackupFile {
  valid: boolean;
  sourceFormat: 'blaugrana-firestore-backup-v2' | 'legacy-db-json' | 'unknown';
  checksumVerified: boolean;
  computedChecksumSha256: string | null;
  declaredChecksumSha256: string | null;
  exportedAt: string | null;
  exportedBy: string | null;
  declaredCatalogVersion: string | null;
  storeInfo: StoreInfo | null;
  socialLinks: SocialLink[];
  products: Product[];
  categoryBreakdown: Record<string, number>;
  errors: string[];
  warnings: string[];
}

export interface BackupRestoreDiffPreview {
  liveExists: boolean;
  liveVersion: string | null;
  liveProductCount: number;
  backupProductCount: number;
  toAdd: Product[];
  toUpdate: Product[];
  unchangedCount: number;
  liveOnlyProducts: Product[];
  storeInfoChanged: boolean;
  socialLinksChanged: boolean;
  matchedAuditRecord: BackupAuditRecord | null;
  readsUsed: number;
  mergeModePlanSummary: {
    resultProductCount: number;
    estimatedProductOps: number;
    estimatedTotalBatchOps: number;
  };
  exactMirrorPlanSummary: {
    resultProductCount: number;
    estimatedProductOps: number;
    estimatedDeleteCount: number;
    estimatedTotalBatchOps: number;
  };
}

export interface BackupRestoreResult {
  mode: RestoreMode;
  version: string;
  updatedAt: string;
  restoredProductCount: number;
  addedCount: number;
  updatedCount: number;
  deletedCount: number;
  preservedLiveOnlyCount: number;
  chunkIds: string[];
  staleChunksDeleted: string[];
  batchesCommitted: number;
  products: Product[];
  storeInfo: StoreInfo;
  socialLinks: SocialLink[];
}

export interface FirestoreBackupAdapter {
  syncAdapter: FirestoreSyncAdapter;
  recordBackupAudit: (record: BackupAuditRecord) => Promise<void>;
  listBackupAudits: (limitCount?: number) => Promise<BackupAuditRecord[]>;
}

const defaultBackupAdapter: FirestoreBackupAdapter = {
  syncAdapter: defaultFirestoreSyncAdapter,
  async recordBackupAudit(record) {
    try {
      await setDoc(doc(db, BACKUPS_COLLECTION, record.id), record);
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.CREATE,
        `${BACKUPS_COLLECTION}/${record.id}`
      );
    }
  },
  async listBackupAudits(limitCount = 10) {
    try {
      const q = query(
        collection(db, BACKUPS_COLLECTION),
        orderBy('createdAt', 'desc'),
        limit(Math.max(1, Math.min(25, limitCount)))
      );
      const snap = await getDocsFromServer(q);
      const records: BackupAuditRecord[] = [];
      for (const docSnap of snap.docs) {
        const raw = docSnap.data() as Partial<BackupAuditRecord>;
        if (
          typeof raw.id === 'string' &&
          typeof raw.createdAt === 'string' &&
          typeof raw.createdBy === 'string' &&
          typeof raw.productCount === 'number' &&
          typeof raw.checksumSha256 === 'string'
        ) {
          records.push({
            id: raw.id,
            createdAt: raw.createdAt,
            createdBy: raw.createdBy,
            productCount: raw.productCount,
            checksumSha256: raw.checksumSha256,
            ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
          });
        }
      }
      return records;
    } catch {
      return [];
    }
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Produces deterministic JSON with lexicographically sorted object keys so SHA-256
 * checksums stay identical across environments and JSON formatting changes.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`)
    .join(',')}}`;
}

function stripProductUpdatedAt(product: Product): Record<string, unknown> {
  const { updatedAt: _omit, ...rest } = product as Product & {
    updatedAt?: string;
  };
  return rest as Record<string, unknown>;
}

function areProductsContentEqual(a: Product, b: Product): boolean {
  return (
    canonicalJsonStringify(stripProductUpdatedAt(a)) ===
    canonicalJsonStringify(stripProductUpdatedAt(b))
  );
}

function cleanProductForBackup(raw: Product): Product {
  const updatedAt =
    typeof (raw as Product & { updatedAt?: string }).updatedAt === 'string'
      ? (raw as Product & { updatedAt?: string }).updatedAt!
      : new Date().toISOString();
  const validated = sanitizeAndValidateProductForFirestore(raw, updatedAt);
  if (validated.product) {
    return validated.product;
  }
  return raw;
}

export async function computeCatalogBackupChecksumSha256(
  payload: BlaugranaBackupDataPayload
): Promise<string> {
  const normalized: BlaugranaBackupDataPayload = {
    storeInfo: payload.storeInfo,
    socialLinks: payload.socialLinks,
    products: [...payload.products].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const encoded = new TextEncoder().encode(canonicalJsonStringify(normalized));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('متصفحك أو بيئة التشغيل لا تدعم دالة SHA-256 (WebCrypto).');
  }
  const digest = await subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function formatBackupDownloadFilename(isoTimestamp: string): string {
  const safe = isoTimestamp
    .replace(/:/g, '-')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '_');
  return `blaugrana-firestore-backup-${safe}.json`;
}

export function triggerJsonFileDownload(
  backup: BlaugranaFirestoreBackupV2,
  filename = formatBackupDownloadFilename(backup.exportedAt)
): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const jsonText = JSON.stringify(backup, null, 2);
  const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}

function computeCategoryBreakdown(products: Product[]): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const p of products) {
    breakdown[p.category] = (breakdown[p.category] ?? 0) + 1;
  }
  return breakdown;
}

function generateBackupAuditId(nowMs = Date.now()): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  const candidate = `bk-${Math.max(1, Math.floor(nowMs))}-${rand}`.replace(
    /[^a-zA-Z0-9_\-]/g,
    ''
  );
  return BACKUP_ID_REGEX.test(candidate) ? candidate : `bk-${nowMs}`;
}

/**
 * Exports a complete, up-to-date catalog backup directly from live Firestore using ONLY
 * `1 + chunkIds.length` reads (3 reads for 229 products on Spark free tier).
 * Records a lightweight SHA-256 audit entry in `backups/{backupId}` (without bloating Firestore
 * with the raw JSON payload) and never modifies any live product/chunk/meta document.
 */
export async function exportLiveCatalogBackupFromFirestore(
  options: {
    user?: User | null;
    adapter?: FirestoreBackupAdapter;
    recordAuditLog?: boolean;
    nowMs?: number;
  } = {}
): Promise<BackupExportResult> {
  const currentUser = options.user === undefined ? auth.currentUser : options.user;
  if (!isAuthorizedAdminUser(currentUser)) {
    throw new Error(
      `غير مصرّح بالتصدير. يجب تسجيل الدخول بحساب Google الموثق (${AUTHORIZED_ADMIN_EMAIL}).`
    );
  }

  const adapter = options.adapter ?? defaultBackupAdapter;
  const live = await fetchAuthoritativeCatalogFromFirestore({
    adapter: adapter.syncAdapter,
  });

  if (!live.exists || live.products.length === 0) {
    throw new Error(
      'لا توجد بيانات كتالوج منشورة في Firestore حالياً لتصديرها.'
    );
  }

  const metaProductCount =
    typeof live.productCount === 'number'
      ? live.productCount
      : live.products.length;
  const catalogUpdatedAt = live.updatedAt ?? new Date().toISOString();
  const readsUsed = 1 + live.chunkIds.length;

  const storeResult = sanitizeStoreInfoStrict(live.storeInfo);
  if (storeResult.errors.length > 0) {
    throw new Error(storeResult.errors[0]);
  }
  const cleanSocialLinks = sanitizeSocialLinksStrict(live.socialLinks);
  const cleanProducts = live.products
    .map(cleanProductForBackup)
    .sort(compareProductsByCode);

  const nowMs = options.nowMs ?? Date.now();
  const exportedAt = new Date(nowMs).toISOString();
  const payload: BlaugranaBackupDataPayload = {
    storeInfo: storeResult.storeInfo,
    socialLinks: cleanSocialLinks,
    products: cleanProducts,
  };
  const checksumSha256 = await computeCatalogBackupChecksumSha256(payload);
  const categoryBreakdown = computeCategoryBreakdown(cleanProducts);

  const backup: BlaugranaFirestoreBackupV2 = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt,
    exportedBy: currentUser!.email!,
    source: {
      projectId: firebaseConfig.projectId,
      databaseId: firebaseConfig.firestoreDatabaseId,
      catalogVersion: live.version ?? 'unknown',
      catalogUpdatedAt,
      chunkIds: live.chunkIds,
    },
    checksumSha256,
    counts: {
      productsCount: cleanProducts.length,
      socialLinksCount: cleanSocialLinks.length,
      categoryBreakdown,
    },
    data: payload,
  };

  let countMismatchWarning: string | undefined;
  if (metaProductCount !== cleanProducts.length) {
    countMismatchWarning = `تنبيه: عدد المنتجات في catalog_meta (${metaProductCount}) يختلف عن مجموع الشرائح (${cleanProducts.length}).`;
  }

  let auditRecord: BackupAuditRecord | null = null;
  let auditWarning: string | undefined;

  if (options.recordAuditLog !== false) {
    const candidateAudit: BackupAuditRecord = {
      id: generateBackupAuditId(nowMs),
      createdAt: exportedAt,
      createdBy: currentUser!.email!,
      productCount: cleanProducts.length,
      checksumSha256,
      summary: `تصدير JSON (${backup.source.catalogVersion}) · ${cleanProducts.length} منتجاً · ${cleanSocialLinks.length} روابط`,
    };
    try {
      await adapter.recordBackupAudit(candidateAudit);
      auditRecord = candidateAudit;
    } catch {
      auditWarning =
        'تم تنزيل ملف النسخة الاحتياطية بنجاح، لكن تعذر تسجيل البصمة في سجل backups السحابي.';
    }
  }

  return {
    backup,
    filename: formatBackupDownloadFilename(exportedAt),
    readsUsed,
    auditRecord,
    ...(auditWarning ? { auditWarning } : {}),
    ...(countMismatchWarning ? { countMismatchWarning } : {}),
  };
}

/**
 * Strictly validates an uploaded JSON backup string locally (ZERO Firestore writes).
 * Checks file size, JSON syntax, schema, SHA-256 integrity, duplicate IDs,
 * and every `firestore.rules` product/storeInfo/chunk/meta constraint.
 */
export async function parseAndValidateBackupFile(
  rawJsonText: string
): Promise<ValidatedBackupFile> {
  const makeError = (
    message: string,
    sourceFormat: ValidatedBackupFile['sourceFormat'] = 'unknown'
  ): ValidatedBackupFile => ({
    valid: false,
    sourceFormat,
    checksumVerified: false,
    computedChecksumSha256: null,
    declaredChecksumSha256: null,
    exportedAt: null,
    exportedBy: null,
    declaredCatalogVersion: null,
    storeInfo: null,
    socialLinks: [],
    products: [],
    categoryBreakdown: {},
    errors: [message],
    warnings: [],
  });

  if (typeof rawJsonText !== 'string' || !rawJsonText.trim()) {
    return makeError('ملف النسخة الاحتياطية فارغ.');
  }

  const byteLen = new TextEncoder().encode(rawJsonText).length;
  if (byteLen > MAX_BACKUP_FILE_BYTES) {
    return makeError(
      'حجم ملف JSON يتجاوز الحد الأقصى المسموح به (10 ميجابايت).'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonText);
  } catch {
    return makeError('ملف JSON غير صالح أو يحتوي على أخطاء في التنسيق.');
  }

  if (!isPlainObject(parsed)) {
    return makeError('بنية ملف النسخة الاحتياطية غير صحيحة.');
  }

  const warnings: string[] = [];
  const errors: string[] = [];
  let sourceFormat: ValidatedBackupFile['sourceFormat'] = 'unknown';
  let rawDataObj: Record<string, unknown> | null = null;
  let declaredChecksum: string | null = null;
  let exportedAt: string | null = null;
  let exportedBy: string | null = null;
  let declaredCatalogVersion: string | null = null;

  if (parsed.schemaVersion === BACKUP_SCHEMA_VERSION) {
    sourceFormat = 'blaugrana-firestore-backup-v2';
    if (!isPlainObject(parsed.data)) {
      return makeError(
        'حقل data مفقود أو غير صالح داخل ملف النسخة الاحتياطية.',
        sourceFormat
      );
    }
    rawDataObj = parsed.data;
    declaredChecksum =
      typeof parsed.checksumSha256 === 'string'
        ? parsed.checksumSha256.trim().toLowerCase()
        : null;
    exportedAt =
      typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null;
    exportedBy =
      typeof parsed.exportedBy === 'string' ? parsed.exportedBy : null;
    if (isPlainObject(parsed.source) && typeof parsed.source.catalogVersion === 'string') {
      declaredCatalogVersion = parsed.source.catalogVersion;
    }

    if (!declaredChecksum || !SHA256_HEX_REGEX.test(declaredChecksum)) {
      return makeError(
        'التوقيع الرقمي checksumSha256 مفقود أو غير صالح في ملف النسخة.',
        sourceFormat
      );
    }
  } else if (Array.isArray(parsed.products)) {
    sourceFormat = 'legacy-db-json';
    rawDataObj = parsed;
    warnings.push(
      'هذا الملف بصيغة النظام القديم / ما قبل الترحيل (بدون توقيع SHA-256)، وتم فحص جميع حقوله مقابل قواعد Firestore.'
    );
  } else {
    return makeError(
      'صيغة الملف غير معروفة. يرجى رفع ملف نسخة احتياطية مصدّر من لوحة إدارة بلوكرانا.'
    );
  }

  if (!Array.isArray(rawDataObj.products) || rawDataObj.products.length === 0) {
    return makeError(
      'قائمة المنتجات فارغة في الملف. تم إيقاف التحقق لحماية الكتالوج الحي.',
      sourceFormat
    );
  }

  if (rawDataObj.products.length > 3000) {
    return makeError(
      `عدد المنتجات في الملف (${rawDataObj.products.length}) يتجاوز الحد التشغيلي المسموح (3000).`,
      sourceFormat
    );
  }

  const storeResult = sanitizeStoreInfoStrict(rawDataObj.storeInfo);
  if (storeResult.errors.length > 0) {
    errors.push(...storeResult.errors);
  }
  const socialLinks = sanitizeSocialLinksStrict(rawDataObj.socialLinks);

  const nowIso = new Date().toISOString();
  const seenIds = new Set<string>();
  const validatedProducts: Product[] = [];

  for (let i = 0; i < rawDataObj.products.length; i += 1) {
    const rawItem = rawDataObj.products[i];
    if (!isPlainObject(rawItem)) {
      errors.push(`السجل رقم ${i + 1} ليس كائناً صالحاً.`);
      continue;
    }
    const rawId = typeof rawItem.id === 'string' ? rawItem.id.trim() : '';
    if (!rawId) {
      errors.push(`السجل رقم ${i + 1} يفتقد معرّف المنتج (id).`);
      continue;
    }
    if (seenIds.has(rawId)) {
      errors.push(`تكرار معرّف المنتج (${rawId}) داخل الملف.`);
      continue;
    }
    seenIds.add(rawId);

    const check = sanitizeAndValidateProductForFirestore(
      rawItem as unknown as Product,
      typeof rawItem.updatedAt === 'string' && rawItem.updatedAt.trim()
        ? rawItem.updatedAt.trim()
        : nowIso
    );
    if (check.errors.length > 0 || !check.product) {
      errors.push(...check.errors.slice(0, 5));
      if (errors.length >= 10) break;
      continue;
    }
    validatedProducts.push(check.product);
  }

  if (errors.length > 0) {
    return {
      valid: false,
      sourceFormat,
      checksumVerified: false,
      computedChecksumSha256: null,
      declaredChecksumSha256: declaredChecksum,
      exportedAt,
      exportedBy,
      declaredCatalogVersion,
      storeInfo: null,
      socialLinks: [],
      products: [],
      categoryBreakdown: {},
      errors: errors.slice(0, 10),
      warnings,
    };
  }

  const sortedProducts = [...validatedProducts].sort(compareProductsByCode);

  // Verify SHA-256 integrity on v2 backups BEFORE any further inspection
  let checksumVerified = false;
  let computedChecksum: string | null = null;
  if (sourceFormat === 'blaugrana-firestore-backup-v2') {
    const rawPayload: BlaugranaBackupDataPayload = {
      storeInfo: rawDataObj.storeInfo as StoreInfo,
      socialLinks: Array.isArray(rawDataObj.socialLinks)
        ? (rawDataObj.socialLinks as SocialLink[])
        : [],
      products: rawDataObj.products as Product[],
    };
    const rawDigest = await computeCatalogBackupChecksumSha256(rawPayload);
    if (rawDigest === declaredChecksum) {
      checksumVerified = true;
      computedChecksum = rawDigest;
    } else {
      return {
        valid: false,
        sourceFormat,
        checksumVerified: false,
        computedChecksumSha256: rawDigest,
        declaredChecksumSha256: declaredChecksum,
        exportedAt,
        exportedBy,
        declaredCatalogVersion,
        storeInfo: null,
        socialLinks: [],
        products: [],
        categoryBreakdown: {},
        errors: [
          'فشل التحقق من التوقيع الرقمي SHA-256: ملف النسخة الاحتياطية معدّل أو تالف ولا يمكن استعادته.',
        ],
        warnings,
      };
    }
  } else {
    computedChecksum = await computeCatalogBackupChecksumSha256({
      storeInfo: storeResult.storeInfo,
      socialLinks,
      products: sortedProducts,
    });
  }

  // Dry-run chunk & meta plan check to guarantee every Firestore document < 1 MiB & <= 30 chunks
  const dryRunPlan = buildCatalogSyncCommitPlan({
    products: sortedProducts,
    storeInfo: storeResult.storeInfo,
    socialLinks,
    changedProductIds: sortedProducts.map((p) => p.id),
    version: createNextCatalogVersion(declaredCatalogVersion, Date.now()),
  });

  if (dryRunPlan.errors.length > 0) {
    return {
      valid: false,
      sourceFormat,
      checksumVerified,
      computedChecksumSha256: computedChecksum,
      declaredChecksumSha256: declaredChecksum,
      exportedAt,
      exportedBy,
      declaredCatalogVersion,
      storeInfo: null,
      socialLinks: [],
      products: [],
      categoryBreakdown: {},
      errors: dryRunPlan.errors,
      warnings,
    };
  }

  const metaStats = measureFirestoreDocumentSize(
    'catalog_meta/public',
    dryRunPlan.metaDoc
  );
  if (metaStats.estimatedFirestoreBytes >= FIRESTORE_DOC_LIMIT_BYTES) {
    return makeError(
      'حجم catalog_meta/public الناتج يتجاوز حد Firestore البالغ 1 MiB.',
      sourceFormat
    );
  }

  return {
    valid: true,
    sourceFormat,
    checksumVerified,
    computedChecksumSha256: computedChecksum,
    declaredChecksumSha256: declaredChecksum,
    exportedAt,
    exportedBy,
    declaredCatalogVersion,
    storeInfo: storeResult.storeInfo,
    socialLinks,
    products: sortedProducts,
    categoryBreakdown: computeCategoryBreakdown(sortedProducts),
    errors: [],
    warnings,
  };
}

/**
 * Strictly READ-ONLY diff preview comparing a validated backup file against live Firestore.
 */
export async function previewBackupRestoreDiff(
  validatedBackup: ValidatedBackupFile,
  options: {
    user?: User | null;
    adapter?: FirestoreBackupAdapter;
  } = {}
): Promise<BackupRestoreDiffPreview> {
  if (!validatedBackup.valid || !validatedBackup.storeInfo) {
    throw new Error('ملف النسخة الاحتياطية غير صالح أو لم ينجح الفحص المسبق.');
  }

  const currentUser = options.user === undefined ? auth.currentUser : options.user;
  if (!isAuthorizedAdminUser(currentUser)) {
    throw new Error(
      `غير مصرّح بالمعاينة. يجب تسجيل الدخول بحساب Google الموثق (${AUTHORIZED_ADMIN_EMAIL}).`
    );
  }

  const adapter = options.adapter ?? defaultBackupAdapter;
  const [live, auditLogs] = await Promise.all([
    fetchAuthoritativeCatalogFromFirestore({ adapter: adapter.syncAdapter }),
    adapter.listBackupAudits(15),
  ]);

  const liveById = new Map<string, Product>(live.products.map((p) => [p.id, p]));
  const backupById = new Map<string, Product>(
    validatedBackup.products.map((p) => [p.id, p])
  );

  const toAdd: Product[] = [];
  const toUpdate: Product[] = [];
  let unchangedCount = 0;

  for (const backupProduct of validatedBackup.products) {
    const existing = liveById.get(backupProduct.id);
    if (!existing) {
      toAdd.push(backupProduct);
    } else if (!areProductsContentEqual(existing, backupProduct)) {
      toUpdate.push(backupProduct);
    } else {
      unchangedCount += 1;
    }
  }

  const liveOnlyProducts: Product[] = [];
  for (const liveProduct of live.products) {
    if (!backupById.has(liveProduct.id)) {
      liveOnlyProducts.push(liveProduct);
    }
  }

  const storeInfoChanged =
    !live.storeInfo ||
    canonicalJsonStringify(live.storeInfo) !==
      canonicalJsonStringify(validatedBackup.storeInfo);

  const socialLinksChanged =
    canonicalJsonStringify(live.socialLinks) !==
    canonicalJsonStringify(validatedBackup.socialLinks);

  const targetChecksum =
    validatedBackup.declaredChecksumSha256 ??
    validatedBackup.computedChecksumSha256;
  const matchedAuditRecord =
    targetChecksum
      ? (auditLogs.find((a) => a.checksumSha256 === targetChecksum) ?? null)
      : null;

  const mergeResultCount =
    validatedBackup.products.length + liveOnlyProducts.length;
  const mergeChunkCount = Math.max(1, Math.ceil(mergeResultCount / 120));
  const mergeProductOps = toAdd.length + toUpdate.length;

  const exactResultCount = validatedBackup.products.length;
  const exactChunkCount = Math.max(1, Math.ceil(exactResultCount / 120));
  const exactStaleChunkDeletes = Math.max(
    0,
    live.chunkIds.length - exactChunkCount
  );
  const exactProductOps =
    toAdd.length + toUpdate.length + liveOnlyProducts.length;

  return {
    liveExists: live.exists,
    liveVersion: live.version,
    liveProductCount: live.products.length,
    backupProductCount: validatedBackup.products.length,
    toAdd,
    toUpdate,
    unchangedCount,
    liveOnlyProducts,
    storeInfoChanged,
    socialLinksChanged,
    matchedAuditRecord,
    readsUsed: 1 + live.chunkIds.length + auditLogs.length,
    mergeModePlanSummary: {
      resultProductCount: mergeResultCount,
      estimatedProductOps: mergeProductOps,
      estimatedTotalBatchOps: mergeProductOps + mergeChunkCount + 1,
    },
    exactMirrorPlanSummary: {
      resultProductCount: exactResultCount,
      estimatedProductOps: exactProductOps,
      estimatedDeleteCount: liveOnlyProducts.length,
      estimatedTotalBatchOps:
        exactProductOps + exactChunkCount + exactStaleChunkDeletes + 1,
    },
  };
}

/**
 * Executes a verified JSON restore onto Firestore using atomic `WriteBatch` commits.
 * Defaults strictly to `merge_preserve_live` (no deletions).
 * `exact_mirror` requires `confirmExactMirror: true` and preserves ALL backup product IDs verbatim.
 */
export async function executeCatalogBackupRestore(
  validatedBackup: ValidatedBackupFile,
  options: {
    user?: User | null;
    adapter?: FirestoreBackupAdapter;
    mode?: RestoreMode;
    confirmExactMirror?: boolean;
    expectedDeleteCount?: number;
    skipCacheInvalidation?: boolean;
    nowMs?: number;
  } = {}
): Promise<BackupRestoreResult> {
  if (!validatedBackup.valid || !validatedBackup.storeInfo) {
    throw new Error('ملف النسخة الاحتياطية لم يجتز التحقق الصارم ولا يمكن استعادته.');
  }

  const currentUser = options.user === undefined ? auth.currentUser : options.user;
  if (!isAuthorizedAdminUser(currentUser)) {
    throw new Error(
      `غير مصرّح بالاستعادة. يجب تسجيل الدخول بحساب Google الموثق (${AUTHORIZED_ADMIN_EMAIL}).`
    );
  }

  const mode: RestoreMode = options.mode ?? 'merge_preserve_live';
  if (mode === 'exact_mirror' && options.confirmExactMirror !== true) {
    throw new Error(
      'يجب تفعيل مربع التأكيد الصريح قبل تنفيذ وضع المطابقة الكاملة الذي قد يحذف منتجات إضافية.'
    );
  }

  const adapter = options.adapter ?? defaultBackupAdapter;
  const live = await fetchAuthoritativeCatalogFromFirestore({
    adapter: adapter.syncAdapter,
  });

  const liveById = new Map<string, Product>(live.products.map((p) => [p.id, p]));
  const backupById = new Map<string, Product>(
    validatedBackup.products.map((p) => [p.id, p])
  );

  const addedIds: string[] = [];
  const updatedIds: string[] = [];
  for (const bp of validatedBackup.products) {
    const existing = liveById.get(bp.id);
    if (!existing) {
      addedIds.push(bp.id);
    } else if (!areProductsContentEqual(existing, bp)) {
      updatedIds.push(bp.id);
    }
  }

  const liveOnlyProducts = live.products.filter((lp) => !backupById.has(lp.id));

  if (
    mode === 'exact_mirror' &&
    options.expectedDeleteCount !== undefined &&
    liveOnlyProducts.length !== options.expectedDeleteCount
  ) {
    throw new Error(
      'تغيّرت البيانات الحية منذ آخر معاينة للفروقات؛ يرجى إعادة المعاينة قبل تنفيذ الاستعادة.'
    );
  }

  const nowMs = options.nowMs ?? Date.now();
  const nextVersion = createNextCatalogVersion(live.version, nowMs);
  const updatedAt = new Date(nowMs).toISOString();

  const finalProducts =
    mode === 'exact_mirror'
      ? [...validatedBackup.products].sort(compareProductsByCode)
      : [...validatedBackup.products, ...liveOnlyProducts].sort(
          compareProductsByCode
        );

  const deletedProductIds =
    mode === 'exact_mirror' ? liveOnlyProducts.map((p) => p.id) : [];

  const plan = buildCatalogSyncCommitPlan({
    products: finalProducts,
    storeInfo: validatedBackup.storeInfo,
    socialLinks: validatedBackup.socialLinks,
    previousChunkIds: live.chunkIds,
    changedProductIds: [...addedIds, ...updatedIds],
    deletedProductIds,
    version: nextVersion,
    updatedAt,
  });

  if (plan.errors.length > 0) {
    throw new Error(plan.errors[0]);
  }

  let batchesCommitted = 0;
  for (const batchOps of plan.batches) {
    if (batchOps.length === 0) continue;
    await adapter.syncAdapter.commitBatch(batchOps);
    batchesCommitted += 1;
  }

  if (!options.skipCacheInvalidation) {
    invalidateCatalogCache();
  }

  return {
    mode,
    version: plan.version,
    updatedAt: plan.updatedAt,
    restoredProductCount: plan.products.length,
    addedCount: addedIds.length,
    updatedCount: updatedIds.length,
    deletedCount: deletedProductIds.length,
    preservedLiveOnlyCount:
      mode === 'merge_preserve_live' ? liveOnlyProducts.length : 0,
    chunkIds: plan.metaDoc.chunkIds,
    staleChunksDeleted: plan.staleChunkIds,
    batchesCommitted,
    products: plan.products,
    storeInfo: plan.metaDoc.storeInfo,
    socialLinks: plan.metaDoc.socialLinks,
  };
}

export async function listRecentBackupAudits(
  options: {
    user?: User | null;
    adapter?: FirestoreBackupAdapter;
    limitCount?: number;
  } = {}
): Promise<BackupAuditRecord[]> {
  const currentUser = options.user === undefined ? auth.currentUser : options.user;
  if (!isAuthorizedAdminUser(currentUser)) return [];
  const adapter = options.adapter ?? defaultBackupAdapter;
  return adapter.listBackupAudits(options.limitCount ?? 8);
}
