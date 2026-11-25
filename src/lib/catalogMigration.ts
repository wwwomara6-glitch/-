import type { User } from 'firebase/auth';
import { doc, getDocFromServer, writeBatch } from 'firebase/firestore';
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
  compareProductsByCode,
  sanitizeHref,
  sanitizeImageInput,
  type Product,
  type ProductCategory,
  type SocialLink,
  type StoreInfo,
} from '../utils/commerce';

export const FIRESTORE_DOC_LIMIT_BYTES = 1_048_576; // 1 MiB
export const SAFE_CHUNK_TARGET_BYTES = 750_000; // ~71% safety ceiling
export const DEFAULT_MIGRATION_CHUNK_SIZE = 120; // <= 150 enforced by firestore.rules

const VALID_ID_REGEX = /^[a-zA-Z0-9_\-]{1,128}$/;
const VERSION_REGEX = /^[a-zA-Z0-9_\-.]{1,64}$/;
const VALID_CATEGORIES = new Set<ProductCategory>([
  'blaugrana',
  'other_brands',
  'body_mist',
  'room_spray',
  'deodorant',
  'hair_care',
  'tester',
]);

export const PUBLIC_PRODUCT_FIELDS = [
  'id',
  'code',
  'name',
  'brand',
  'category',
  'priceIqd',
  'size',
  'sizePrices',
  'notes',
  'topNotes',
  'heartNotes',
  'baseNotes',
  'longevity',
  'sillage',
  'description',
  'imageUrl',
  'hasCustomImage',
  'includesFreeTester',
  'inStock',
  'updatedAt',
] as const;

export const EXCLUDED_SENSITIVE_FIELDS = [
  'promoCodes',
  'orders',
  'orderTrackings',
  'customRequests',
  'notifications',
  'loyaltyByPhone',
  'orderSequence',
  'adminCredential',
  'telegramConfig',
  'sessionSecret',
  'deletedSeedIds',
] as const;

export interface RawMigrationDatabaseInput {
  storeInfo?: unknown;
  socialLinks?: unknown;
  products?: unknown;
  [key: string]: unknown;
}

export interface MigratedProductDoc extends Product {
  updatedAt: string;
}

export interface MigratedCatalogChunkDoc {
  chunkIndex: number;
  version: string;
  items: MigratedProductDoc[];
  updatedAt: string;
}

export interface MigratedCatalogMetaDoc {
  version: string;
  productCount: number;
  chunkIds: string[];
  storeInfo: StoreInfo;
  socialLinks: SocialLink[];
  updatedAt: string;
}

export interface DocumentSizeStats {
  path: string;
  jsonBytes: number;
  estimatedFirestoreBytes: number;
  percentOf1MiBLimit: number;
  within1MiBLimit: boolean;
}

export interface MigrationConflictIssue {
  productId: string;
  code: string;
  severity: 'error' | 'warning';
  field: string;
  message: string;
}

export interface CatalogMigrationPlan {
  dryRunOnly: true;
  version: string;
  generatedAt: string;
  metaDoc: MigratedCatalogMetaDoc;
  chunkDocs: Array<{ chunkId: string; data: MigratedCatalogChunkDoc }>;
  productDocs: Array<{ productId: string; data: MigratedProductDoc }>;
  totalFirestoreWritesPlanned: number;
  categoryBreakdown: Record<string, number>;
  documentSizes: {
    meta: DocumentSizeStats;
    chunks: DocumentSizeStats[];
    maxProduct: DocumentSizeStats;
    minProductJsonBytes: number;
    avgProductJsonBytes: number;
    allWithin1MiBLimit: boolean;
  };
  includedDataSummary: {
    storeInfoIncluded: boolean;
    socialLinksCount: number;
    productsCount: number;
    publicProductFields: readonly string[];
  };
  excludedSensitiveSummary: {
    excludedKeysFoundInSource: string[];
    excludedRecordCounts: Record<string, number>;
  };
  issues: MigrationConflictIssue[];
  readyForExecution: boolean;
}

function utf8ByteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

/**
 * Estimates Firestore serialized document size in bytes using Firestore's documented overhead rules:
 * documentNameOverhead + 32 + sum(fieldNameBytes + 1 + valueBytes).
 */
export function estimateFirestoreValueBytes(value: unknown): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 8;
  if (typeof value === 'string') return utf8ByteLength(value) + 1;
  if (Array.isArray(value)) {
    let total = 4;
    for (const item of value) {
      total += estimateFirestoreValueBytes(item);
    }
    return total;
  }
  if (typeof value === 'object') {
    let total = 32;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      total += utf8ByteLength(k) + 1 + estimateFirestoreValueBytes(v);
    }
    return total;
  }
  return 8;
}

export function measureFirestoreDocumentSize(
  docPath: string,
  payload: unknown
): DocumentSizeStats {
  const jsonBytes = utf8ByteLength(JSON.stringify(payload));
  const pathSegmentsBytes = docPath
    .split('/')
    .reduce((acc, seg) => acc + utf8ByteLength(seg) + 1, 16);
  const estimatedFirestoreBytes = pathSegmentsBytes + estimateFirestoreValueBytes(payload);
  const percentOf1MiBLimit = Number(
    ((estimatedFirestoreBytes / FIRESTORE_DOC_LIMIT_BYTES) * 100).toFixed(2)
  );
  return {
    path: docPath,
    jsonBytes,
    estimatedFirestoreBytes,
    percentOf1MiBLimit,
    within1MiBLimit: estimatedFirestoreBytes < FIRESTORE_DOC_LIMIT_BYTES,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sanitizeStoreInfo(raw: unknown, issues: MigrationConflictIssue[]): StoreInfo {
  const src = isPlainObject(raw) ? raw : {};
  const agencyName = typeof src.agencyName === 'string' ? src.agencyName.trim() : '';
  const locationText = typeof src.locationText === 'string' ? src.locationText.trim() : '';
  const city = typeof src.city === 'string' ? src.city.trim() : '';
  const guaranteeTitle = typeof src.guaranteeTitle === 'string' ? src.guaranteeTitle.trim() : '';
  const guaranteeText = typeof src.guaranteeText === 'string' ? src.guaranteeText.trim() : '';
  const freeDeliveryThresholdIqd =
    typeof src.freeDeliveryThresholdIqd === 'number' && Number.isFinite(src.freeDeliveryThresholdIqd)
      ? Math.max(0, Math.round(src.freeDeliveryThresholdIqd))
      : -1;
  const standardDeliveryFeeIqd =
    typeof src.standardDeliveryFeeIqd === 'number' && Number.isFinite(src.standardDeliveryFeeIqd)
      ? Math.max(0, Math.round(src.standardDeliveryFeeIqd))
      : -1;

  if (agencyName.length < 2 || agencyName.length > 120) {
    issues.push({ productId: 'storeInfo', code: '-', severity: 'error', field: 'agencyName', message: 'اسم الوكالة غير مطابق لقيود الطول (2..120).' });
  }
  if (locationText.length < 2 || locationText.length > 240) {
    issues.push({ productId: 'storeInfo', code: '-', severity: 'error', field: 'locationText', message: 'عنوان الموقع غير مطابق لقيود الطول (2..240).' });
  }
  if (city.length < 2 || city.length > 100) {
    issues.push({ productId: 'storeInfo', code: '-', severity: 'error', field: 'city', message: 'المدينة غير مطابقة لقيود الطول (2..100).' });
  }
  if (freeDeliveryThresholdIqd < 0 || standardDeliveryFeeIqd < 0) {
    issues.push({ productId: 'storeInfo', code: '-', severity: 'error', field: 'deliveryFees', message: 'قيم التوصيل غير صالحة.' });
  }
  if (guaranteeTitle.length < 2 || guaranteeTitle.length > 200) {
    issues.push({ productId: 'storeInfo', code: '-', severity: 'error', field: 'guaranteeTitle', message: 'عنوان الضمان غير مطابق لقيود الطول (2..200).' });
  }
  if (guaranteeText.length < 2 || guaranteeText.length > 600) {
    issues.push({ productId: 'storeInfo', code: '-', severity: 'error', field: 'guaranteeText', message: 'نص الضمان غير مطابق لقيود الطول (2..600).' });
  }

  return {
    agencyName,
    locationText,
    city,
    freeDeliveryThresholdIqd: Math.max(0, freeDeliveryThresholdIqd),
    standardDeliveryFeeIqd: Math.max(0, standardDeliveryFeeIqd),
    guaranteeTitle,
    guaranteeText,
  };
}

function sanitizeSocialLinks(raw: unknown, issues: MigrationConflictIssue[]): SocialLink[] {
  if (!Array.isArray(raw)) {
    issues.push({ productId: 'socialLinks', code: '-', severity: 'error', field: 'socialLinks', message: 'قائمة روابط التواصل ليست مصفوفة.' });
    return [];
  }
  if (raw.length > 20) {
    issues.push({ productId: 'socialLinks', code: '-', severity: 'error', field: 'socialLinks', message: 'عدد روابط التواصل يتجاوز الحد المسموح (20).' });
  }
  const clean: SocialLink[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!isPlainObject(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const platform = typeof item.platform === 'string' ? item.platform.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const handle = typeof item.handle === 'string' ? item.handle.trim() : '';
    const url = typeof item.url === 'string' ? sanitizeHref(item.url) : '#';
    if (!id || !platform || !label) {
      issues.push({ productId: 'socialLinks', code: id || '-', severity: 'error', field: 'socialLinks', message: 'رابط تواصل ينقصه id أو platform أو label.' });
      continue;
    }
    clean.push({ id, platform, label, handle, url });
  }
  return clean;
}

function validateAndSanitizeProduct(
  raw: unknown,
  updatedAt: string,
  issues: MigrationConflictIssue[]
): MigratedProductDoc | null {
  if (!isPlainObject(raw)) {
    issues.push({ productId: 'unknown', code: 'unknown', severity: 'error', field: 'record', message: 'سجل منتج غير صالح.' });
    return null;
  }

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
  const rawImageUrl = typeof raw.imageUrl === 'string' ? raw.imageUrl.trim() : '';
  const imageUrl = sanitizeImageInput(rawImageUrl);

  if (!VALID_ID_REGEX.test(id)) {
    issues.push({ productId: id || 'missing', code, severity: 'error', field: 'id', message: 'معرّف المنتج غير مطابق للنمط المسموح في قواعد Firestore.' });
  }
  if (code.length < 1 || code.length > 64) {
    issues.push({ productId: id, code, severity: 'error', field: 'code', message: 'كود المنتج خارج النطاق (1..64).' });
  }
  if (name.length < 1 || name.length > 160) {
    issues.push({ productId: id, code, severity: 'error', field: 'name', message: 'اسم المنتج خارج النطاق (1..160).' });
  }
  if (brand.length < 1 || brand.length > 120) {
    issues.push({ productId: id, code, severity: 'error', field: 'brand', message: 'الماركة خارج النطاق (1..120).' });
  }
  if (!VALID_CATEGORIES.has(category)) {
    issues.push({ productId: id, code, severity: 'error', field: 'category', message: `التصنيف (${String(raw.category)}) غير معروف.` });
  }
  if (!Number.isInteger(priceIqd) || priceIqd < 500 || priceIqd > 50000000) {
    issues.push({ productId: id, code, severity: 'error', field: 'priceIqd', message: `السعر (${priceIqd}) خارج الحدود المسموحة (500..50,000,000).` });
  }
  if (size.length < 1 || size.length > 40) {
    issues.push({ productId: id, code, severity: 'error', field: 'size', message: 'الحجم غير صالح أو يتجاوز 40 حرفاً.' });
  }
  if (notes.length < 1 || notes.length > 600) {
    issues.push({ productId: id, code, severity: 'error', field: 'notes', message: `النوتات (${notes.length} حرف) خارج النطاق (1..600).` });
  }
  if (longevity.length < 1 || longevity.length > 80) {
    issues.push({ productId: id, code, severity: 'error', field: 'longevity', message: 'الثبات خارج النطاق (1..80).' });
  }
  if (sillage.length < 1 || sillage.length > 80) {
    issues.push({ productId: id, code, severity: 'error', field: 'sillage', message: 'الفوحان خارج النطاق (1..80).' });
  }
  if (description.length < 1 || description.length > 1000) {
    issues.push({ productId: id, code, severity: 'error', field: 'description', message: `الوصف (${description.length} حرف) خارج النطاق (1..1000).` });
  }
  if (!rawImageUrl || imageUrl.length > 1000) {
    issues.push({ productId: id, code, severity: 'error', field: 'imageUrl', message: `رابط الصورة (${imageUrl.length} حرف) غير صالح أو يتجاوز 1000 حرف.` });
  }
  if (typeof raw.includesFreeTester !== 'boolean') {
    issues.push({ productId: id, code, severity: 'error', field: 'includesFreeTester', message: 'الحقل includesFreeTester ليس قيمة منطقية.' });
  }
  if (typeof raw.inStock !== 'boolean') {
    issues.push({ productId: id, code, severity: 'error', field: 'inStock', message: 'الحقل inStock ليس قيمة منطقية.' });
  }

  let sizePrices: Record<string, number> | undefined;
  if (raw.sizePrices !== undefined) {
    if (!isPlainObject(raw.sizePrices)) {
      issues.push({ productId: id, code, severity: 'error', field: 'sizePrices', message: 'sizePrices يجب أن يكون كائناً.' });
    } else {
      const cleanPrices: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw.sizePrices)) {
        const sk = k.trim();
        if (sk && typeof v === 'number' && Number.isFinite(v) && v >= 500) {
          cleanPrices[sk] = Math.round(v);
        } else {
          issues.push({ productId: id, code, severity: 'error', field: 'sizePrices', message: `سعر الحجم (${k}) غير صالح.` });
        }
      }
      if (Object.keys(cleanPrices).length > 10) {
        issues.push({ productId: id, code, severity: 'error', field: 'sizePrices', message: 'عدد الأحجام يتجاوز 10.' });
      }
      if (Object.keys(cleanPrices).length > 0) {
        sizePrices = cleanPrices;
      }
    }
  }

  const topNotes = typeof raw.topNotes === 'string' ? raw.topNotes.trim() : undefined;
  const heartNotes = typeof raw.heartNotes === 'string' ? raw.heartNotes.trim() : undefined;
  const baseNotes = typeof raw.baseNotes === 'string' ? raw.baseNotes.trim() : undefined;

  if (topNotes && topNotes.length > 240) {
    issues.push({ productId: id, code, severity: 'error', field: 'topNotes', message: 'topNotes يتجاوز 240 حرفاً.' });
  }
  if (heartNotes && heartNotes.length > 240) {
    issues.push({ productId: id, code, severity: 'error', field: 'heartNotes', message: 'heartNotes يتجاوز 240 حرفاً.' });
  }
  if (baseNotes && baseNotes.length > 240) {
    issues.push({ productId: id, code, severity: 'error', field: 'baseNotes', message: 'baseNotes يتجاوز 240 حرفاً.' });
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
    ...(topNotes ? { topNotes } : {}),
    ...(heartNotes ? { heartNotes } : {}),
    ...(baseNotes ? { baseNotes } : {}),
    longevity,
    sillage,
    description,
    imageUrl,
    ...(typeof raw.hasCustomImage === 'boolean' ? { hasCustomImage: raw.hasCustomImage } : {}),
    includesFreeTester: Boolean(raw.includesFreeTester),
    inStock: Boolean(raw.inStock),
    updatedAt,
  };
}

export function buildCatalogMigrationPlan(
  sourceDb: RawMigrationDatabaseInput,
  options: {
    version?: string;
    generatedAt?: string;
    chunkSize?: number;
  } = {}
): CatalogMigrationPlan {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const version = options.version ?? 'v1.0.0-initial';
  const chunkSize = Math.min(150, Math.max(1, options.chunkSize ?? DEFAULT_MIGRATION_CHUNK_SIZE));

  const issues: MigrationConflictIssue[] = [];
  if (!VERSION_REGEX.test(version)) {
    issues.push({ productId: 'catalog_meta', code: '-', severity: 'error', field: 'version', message: 'صيغة الإصدار غير صالحة.' });
  }

  const storeInfo = sanitizeStoreInfo(sourceDb.storeInfo, issues);
  const socialLinks = sanitizeSocialLinks(sourceDb.socialLinks, issues);

  const rawProducts = Array.isArray(sourceDb.products) ? sourceDb.products : [];
  const seenIds = new Set<string>();
  const seenCodes = new Set<string>();
  const productDocs: Array<{ productId: string; data: MigratedProductDoc }> = [];
  const categoryBreakdown: Record<string, number> = {};

  for (const rawProduct of rawProducts) {
    const clean = validateAndSanitizeProduct(rawProduct, generatedAt, issues);
    if (!clean) continue;

    if (seenIds.has(clean.id)) {
      issues.push({
        productId: clean.id,
        code: clean.code,
        severity: 'error',
        field: 'id',
        message: `تكرار في معرّف المنتج: ${clean.id}`,
      });
      continue;
    }
    seenIds.add(clean.id);

    if (seenCodes.has(clean.code)) {
      issues.push({
        productId: clean.id,
        code: clean.code,
        severity: 'warning',
        field: 'code',
        message: `تكرار في كود المنتج: ${clean.code}`,
      });
    }
    seenCodes.add(clean.code);

    categoryBreakdown[clean.category] = (categoryBreakdown[clean.category] ?? 0) + 1;
    productDocs.push({ productId: clean.id, data: clean });
  }

  productDocs.sort((a, b) => compareProductsByCode(a.data, b.data));

  const chunkDocs: Array<{ chunkId: string; data: MigratedCatalogChunkDoc }> = [];
  const chunkIds: string[] = [];

  for (let i = 0; i < productDocs.length; i += chunkSize) {
    const chunkIndex = chunkDocs.length;
    const chunkId = `chunk_${chunkIndex}`;
    const items = productDocs.slice(i, i + chunkSize).map((p) => p.data);
    chunkIds.push(chunkId);
    chunkDocs.push({
      chunkId,
      data: {
        chunkIndex,
        version,
        items,
        updatedAt: generatedAt,
      },
    });
  }

  if (chunkIds.length > 30) {
    issues.push({
      productId: 'catalog_meta',
      code: '-',
      severity: 'error',
      field: 'chunkIds',
      message: `عدد الشرائح (${chunkIds.length}) يتجاوز حد 30 في قواعد الأمان.`,
    });
  }

  const metaDoc: MigratedCatalogMetaDoc = {
    version,
    productCount: productDocs.length,
    chunkIds,
    storeInfo,
    socialLinks,
    updatedAt: generatedAt,
  };

  const metaSize = measureFirestoreDocumentSize('catalog_meta/public', metaDoc);
  const chunkSizes = chunkDocs.map((c) =>
    measureFirestoreDocumentSize(`catalog_chunks/${c.chunkId}`, c.data)
  );

  let maxProductSize: DocumentSizeStats = {
    path: 'products/none',
    jsonBytes: 0,
    estimatedFirestoreBytes: 0,
    percentOf1MiBLimit: 0,
    within1MiBLimit: true,
  };
  let minProductJsonBytes = productDocs.length > 0 ? Number.MAX_SAFE_INTEGER : 0;
  let totalProductJsonBytes = 0;

  for (const p of productDocs) {
    const stats = measureFirestoreDocumentSize(`products/${p.productId}`, p.data);
    totalProductJsonBytes += stats.jsonBytes;
    if (stats.jsonBytes < minProductJsonBytes) minProductJsonBytes = stats.jsonBytes;
    if (stats.estimatedFirestoreBytes > maxProductSize.estimatedFirestoreBytes) {
      maxProductSize = stats;
    }
  }

  const allWithin1MiBLimit =
    metaSize.within1MiBLimit &&
    chunkSizes.every((c) => c.within1MiBLimit) &&
    maxProductSize.within1MiBLimit;

  if (!allWithin1MiBLimit) {
    issues.push({
      productId: 'size-check',
      code: '-',
      severity: 'error',
      field: 'documentSize',
      message: 'يوجد مستند يتجاوز حد Firestore البالغ 1 MiB.',
    });
  }

  const excludedKeysFoundInSource: string[] = [];
  const excludedRecordCounts: Record<string, number> = {};
  for (const key of EXCLUDED_SENSITIVE_FIELDS) {
    if (key in sourceDb) {
      excludedKeysFoundInSource.push(key);
      const val = sourceDb[key];
      if (Array.isArray(val)) excludedRecordCounts[key] = val.length;
      else if (isPlainObject(val)) excludedRecordCounts[key] = Object.keys(val).length;
      else if (typeof val === 'number') excludedRecordCounts[key] = val;
      else excludedRecordCounts[key] = val ? 1 : 0;
    }
  }

  const hasBlockingError = issues.some((i) => i.severity === 'error');

  return {
    dryRunOnly: true,
    version,
    generatedAt,
    metaDoc,
    chunkDocs,
    productDocs,
    totalFirestoreWritesPlanned: 1 + chunkDocs.length + productDocs.length,
    categoryBreakdown,
    documentSizes: {
      meta: metaSize,
      chunks: chunkSizes,
      maxProduct: maxProductSize,
      minProductJsonBytes,
      avgProductJsonBytes:
        productDocs.length > 0 ? Math.round(totalProductJsonBytes / productDocs.length) : 0,
      allWithin1MiBLimit,
    },
    includedDataSummary: {
      storeInfoIncluded: true,
      socialLinksCount: socialLinks.length,
      productsCount: productDocs.length,
      publicProductFields: PUBLIC_PRODUCT_FIELDS,
    },
    excludedSensitiveSummary: {
      excludedKeysFoundInSource,
      excludedRecordCounts,
    },
    issues,
    readyForExecution: !hasBlockingError && allWithin1MiBLimit && productDocs.length === 229,
  };
}

export const FIRESTORE_SAFE_BATCH_SIZE = 400;

export interface ExistingDocInspection {
  path: string;
  matchStatus: 'identical' | 'different';
}

export interface MigrationExecutionResult {
  executedByEmail: string;
  batchesCommitted: number;
  totalPlannedDocs: number;
  writtenCount: number;
  skippedExistingCount: number;
  skippedExisting: ExistingDocInspection[];
  writtenPaths: string[];
}

export interface MigrationBatchAdapter {
  getExistingDoc: (
    collectionName: string,
    docId: string
  ) => Promise<{ exists: boolean; data: Record<string, unknown> | undefined }>;
  commitBatch: (
    entries: Array<{ collectionName: string; docId: string; data: unknown }>
  ) => Promise<void>;
}

const defaultMigrationBatchAdapter: MigrationBatchAdapter = {
  async getExistingDoc(collectionName, docId) {
    const ref = doc(db, collectionName, docId);
    try {
      const snap = await getDocFromServer(ref);
      return {
        exists: snap.exists(),
        data: snap.exists() ? (snap.data() as Record<string, unknown>) : undefined,
      };
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `${collectionName}/${docId}`);
    }
  },
  async commitBatch(entries) {
    const batch = writeBatch(db);
    for (const entry of entries) {
      batch.set(doc(db, entry.collectionName, entry.docId), entry.data as Record<string, unknown>);
    }
    try {
      await batch.commit();
    } catch (error) {
      const firstPath = entries[0]
        ? `${entries[0].collectionName}/${entries[0].docId}`
        : 'catalog_meta/public';
      handleFirestoreError(error, OperationType.WRITE, firstPath);
    }
  },
};

function canonicalComparePayload(a: unknown, b: unknown): boolean {
  const stripUpdatedAt = (obj: unknown): unknown => {
    if (!isPlainObject(obj)) return obj;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (key === 'updatedAt') continue;
      out[key] = obj[key];
    }
    return out;
  };
  return JSON.stringify(stripUpdatedAt(a)) === JSON.stringify(stripUpdatedAt(b));
}

export interface MigrationPreInspectionResult {
  totalPlannedDocs: number;
  productsCount: number;
  existingDocsCount: number;
  toWriteCount: number;
  skippedExisting: ExistingDocInspection[];
}

export interface MigrationPostVerificationResult {
  verified: boolean;
  metaExists: boolean;
  metaVersion: string | null;
  metaProductCount: number;
  chunkDocsVerified: number;
  chunkItemsCount: number;
  productDocsVerified: number;
  priceMismatches: number;
  imageMismatches: number;
  missingPaths: string[];
}

function buildPlannedMigrationEntries(plan: CatalogMigrationPlan): Array<{
  collectionName: string;
  docId: string;
  data: unknown;
}> {
  return [
    ...plan.productDocs.map((p) => ({
      collectionName: 'products',
      docId: p.productId,
      data: p.data,
    })),
    ...plan.chunkDocs.map((c) => ({
      collectionName: 'catalog_chunks',
      docId: c.chunkId,
      data: c.data,
    })),
    {
      collectionName: 'catalog_meta',
      docId: 'public',
      data: plan.metaDoc,
    },
  ];
}

/**
 * Strictly READ-ONLY pre-inspection run by the verified owner before pressing
 * the migration button: reports exact existing vs new docs that will be skipped/written.
 */
export async function inspectExistingMigrationDocs(
  plan: CatalogMigrationPlan,
  options: {
    user?: User | null;
    adapter?: MigrationBatchAdapter;
  } = {}
): Promise<MigrationPreInspectionResult> {
  const currentUser = options.user === undefined ? auth.currentUser : options.user;
  if (!isAuthorizedAdminUser(currentUser)) {
    throw new Error(
      `غير مصرّح بالفحص. يجب تسجيل الدخول بحساب Google الموثق (${AUTHORIZED_ADMIN_EMAIL}).`
    );
  }

  const adapter = options.adapter ?? defaultMigrationBatchAdapter;
  const plannedEntries = buildPlannedMigrationEntries(plan);
  const skippedExisting: ExistingDocInspection[] = [];

  const INSPECTION_CONCURRENCY = 25;
  for (let i = 0; i < plannedEntries.length; i += INSPECTION_CONCURRENCY) {
    const slice = plannedEntries.slice(i, i + INSPECTION_CONCURRENCY);
    const checks = await Promise.all(
      slice.map(async (entry) => ({
        entry,
        existing: await adapter.getExistingDoc(entry.collectionName, entry.docId),
      }))
    );
    for (const { entry, existing } of checks) {
      if (existing.exists) {
        const isIdentical = canonicalComparePayload(existing.data, entry.data);
        skippedExisting.push({
          path: `${entry.collectionName}/${entry.docId}`,
          matchStatus: isIdentical ? 'identical' : 'different',
        });
      }
    }
  }

  return {
    totalPlannedDocs: plannedEntries.length,
    productsCount: plan.productDocs.length,
    existingDocsCount: skippedExisting.length,
    toWriteCount: plannedEntries.length - skippedExisting.length,
    skippedExisting,
  };
}

/**
 * Strictly READ-ONLY post-migration verifier run after WriteBatch commits:
 * confirms doc counts, product count, prices, imageUrls, and version directly from Firestore.
 */
export async function verifyMigratedCatalogInFirestore(
  plan: CatalogMigrationPlan,
  options: {
    user?: User | null;
    adapter?: MigrationBatchAdapter;
  } = {}
): Promise<MigrationPostVerificationResult> {
  const currentUser = options.user === undefined ? auth.currentUser : options.user;
  if (!isAuthorizedAdminUser(currentUser)) {
    throw new Error(
      `غير مصرّح بالتحقق. يجب تسجيل الدخول بحساب Google الموثق (${AUTHORIZED_ADMIN_EMAIL}).`
    );
  }

  const adapter = options.adapter ?? defaultMigrationBatchAdapter;
  const missingPaths: string[] = [];

  const metaRes = await adapter.getExistingDoc('catalog_meta', 'public');
  const metaExists = metaRes.exists;
  const metaData = metaRes.data;
  if (!metaExists) {
    missingPaths.push('catalog_meta/public');
  }
  const metaVersion = typeof metaData?.version === 'string' ? metaData.version : null;
  const metaProductCount =
    typeof metaData?.productCount === 'number' ? metaData.productCount : 0;

  let chunkDocsVerified = 0;
  let chunkItemsCount = 0;
  for (const chunk of plan.chunkDocs) {
    const chunkRes = await adapter.getExistingDoc('catalog_chunks', chunk.chunkId);
    if (!chunkRes.exists) {
      missingPaths.push(`catalog_chunks/${chunk.chunkId}`);
      continue;
    }
    chunkDocsVerified += 1;
    if (Array.isArray(chunkRes.data?.items)) {
      chunkItemsCount += chunkRes.data.items.length;
    }
  }

  let productDocsVerified = 0;
  let priceMismatches = 0;
  let imageMismatches = 0;

  const CONCURRENCY = 25;
  for (let i = 0; i < plan.productDocs.length; i += CONCURRENCY) {
    const slice = plan.productDocs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (p) => ({
        expected: p,
        remote: await adapter.getExistingDoc('products', p.productId),
      }))
    );
    for (const { expected, remote } of results) {
      if (!remote.exists || !remote.data) {
        missingPaths.push(`products/${expected.productId}`);
        continue;
      }
      productDocsVerified += 1;
      if (remote.data.priceIqd !== expected.data.priceIqd) {
        priceMismatches += 1;
      }
      if (remote.data.imageUrl !== expected.data.imageUrl) {
        imageMismatches += 1;
      }
    }
  }

  const verified =
    metaExists &&
    metaVersion === plan.version &&
    metaProductCount === plan.productDocs.length &&
    chunkDocsVerified === plan.chunkDocs.length &&
    chunkItemsCount === plan.productDocs.length &&
    productDocsVerified === plan.productDocs.length &&
    priceMismatches === 0 &&
    imageMismatches === 0 &&
    missingPaths.length === 0;

  return {
    verified,
    metaExists,
    metaVersion,
    metaProductCount,
    chunkDocsVerified,
    chunkItemsCount,
    productDocsVerified,
    priceMismatches,
    imageMismatches,
    missingPaths,
  };
}

/**
 * Executes a client-side Firestore `WriteBatch` migration using ONLY the verified owner's
 * Google Auth session (`wwwomara6@gmail.com`). Never uses a Service Account or Worker,
 * and pre-inspects every target document so existing documents are never blindly overwritten.
 */
export async function executeSafeCatalogMigrationWithWriteBatch(
  plan: CatalogMigrationPlan,
  options: {
    user?: User | null;
    overwriteExisting?: boolean;
    adapter?: MigrationBatchAdapter;
  } = {}
): Promise<MigrationExecutionResult> {
  const currentUser = options.user === undefined ? auth.currentUser : options.user;
  if (!isAuthorizedAdminUser(currentUser)) {
    throw new Error(
      `غير مصرّح بتنفيذ النقل. يجب تسجيل الدخول بحساب Google الموثق (${AUTHORIZED_ADMIN_EMAIL}).`
    );
  }

  if (!plan.readyForExecution) {
    throw new Error('خطة النقل غير جاهزة للتنفيذ بسبب وجود أخطاء في الفحص المسبق.');
  }

  const adapter = options.adapter ?? defaultMigrationBatchAdapter;
  const overwriteExisting = Boolean(options.overwriteExisting);
  const plannedEntries = buildPlannedMigrationEntries(plan);

  const skippedExisting: ExistingDocInspection[] = [];
  const entriesToWrite: Array<{
    collectionName: string;
    docId: string;
    data: unknown;
  }> = [];

  // Pre-check every planned document on Firestore server before adding to WriteBatch
  const INSPECTION_CONCURRENCY = 25;
  for (let i = 0; i < plannedEntries.length; i += INSPECTION_CONCURRENCY) {
    const slice = plannedEntries.slice(i, i + INSPECTION_CONCURRENCY);
    const checks = await Promise.all(
      slice.map(async (entry) => ({
        entry,
        existing: await adapter.getExistingDoc(entry.collectionName, entry.docId),
      }))
    );

    for (const { entry, existing } of checks) {
      const path = `${entry.collectionName}/${entry.docId}`;
      if (existing.exists) {
        const isIdentical = canonicalComparePayload(existing.data, entry.data);
        if (!overwriteExisting) {
          skippedExisting.push({
            path,
            matchStatus: isIdentical ? 'identical' : 'different',
          });
          continue;
        }
      }
      entriesToWrite.push(entry);
    }
  }

  let batchesCommitted = 0;
  for (let i = 0; i < entriesToWrite.length; i += FIRESTORE_SAFE_BATCH_SIZE) {
    const batchSlice = entriesToWrite.slice(i, i + FIRESTORE_SAFE_BATCH_SIZE);
    await adapter.commitBatch(batchSlice);
    batchesCommitted += 1;
  }

  if (entriesToWrite.length > 0) {
    invalidateCatalogCache();
  }

  return {
    executedByEmail: currentUser!.email!,
    batchesCommitted,
    totalPlannedDocs: plannedEntries.length,
    writtenCount: entriesToWrite.length,
    skippedExistingCount: skippedExisting.length,
    skippedExisting,
    writtenPaths: entriesToWrite.map((e) => `${e.collectionName}/${e.docId}`),
  };
}


