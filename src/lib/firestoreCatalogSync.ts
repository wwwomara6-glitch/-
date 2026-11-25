import type { User } from 'firebase/auth';
import { doc, getDocFromServer, writeBatch } from 'firebase/firestore';
import {
  DEFAULT_MIGRATION_CHUNK_SIZE,
  FIRESTORE_SAFE_BATCH_SIZE,
  measureFirestoreDocumentSize,
  type MigratedCatalogChunkDoc,
  type MigratedCatalogMetaDoc,
  type MigratedProductDoc,
} from './catalogMigration';
import {
  AUTHORIZED_ADMIN_EMAIL,
  auth,
  db,
  handleFirestoreError,
  isAuthorizedAdminUser,
  OperationType,
} from './firebase';
import {
  CATALOG_CHUNKS_COLLECTION,
  CATALOG_META_COLLECTION,
  CATALOG_META_DOC_ID,
  invalidateCatalogCache,
} from './firebaseCatalog';
import {
  compareProductsByCode,
  isQualifyingPerfumeCategory,
  sanitizeHref,
  sanitizeImageInput,
  type Product,
  type ProductCategory,
  type SocialLink,
  type StoreInfo,
} from '../utils/commerce';

const VALID_ID_REGEX = /^[a-zA-Z0-9_\-]{1,128}$/;
const VERSION_REGEX = /^[a-zA-Z0-9_\-.]{1,64}$/;
const VALID_CHUNK_ID_REGEX = /^chunk_[0-9]{1,3}$/;
const VALID_CATEGORIES = new Set<ProductCategory>([
  'blaugrana',
  'other_brands',
  'body_mist',
  'room_spray',
  'deodorant',
  'hair_care',
  'tester',
]);

const DEFAULT_CATEGORY_IMAGES: Record<ProductCategory, string> = {
  blaugrana: '/src/assets/images/perfume_signature_oud_1795208161900.jpg',
  other_brands: '/src/assets/images/perfume_crimson_rose_1795208162606.jpg',
  body_mist: '/src/assets/images/product_body_mist_1795208162237.jpg',
  room_spray: '/src/assets/images/product_body_mist_1795208162237.jpg',
  deodorant: '/src/assets/images/product_body_mist_1795208162237.jpg',
  hair_care: '/assets/aistudio/hair_shampoo_studio.jpg',
  tester: '/src/assets/images/product_tester_kit_1795208162880.jpg',
};

const FALLBACK_STORE_INFO: StoreInfo = {
  agencyName: 'وكالة بلوكرانا للعطور',
  locationText: 'العراق - ديالى - بعقوبة - التحرير - شارع الحسينية',
  city: 'ديالى - بعقوبة',
  freeDeliveryThresholdIqd: 20000,
  standardDeliveryFeeIqd: 5000,
  guaranteeTitle: 'ضمان الثبات والفوحان الذهبي + تيستر مجاني مع كل عطر',
  guaranteeText:
    'كل عطر تطلبه من وكالة بلوكرانا يصلك مع عينة تيستر مجانية للتجربة قبل فتح العبوة الأصلية، مع ضمان حقيقي للثبات والفوحان.',
};

export interface FirestoreSyncBatchOp {
  type: 'set' | 'delete';
  collectionName: 'products' | 'catalog_chunks' | 'catalog_meta';
  docId: string;
  data?: unknown;
}

export interface FirestoreCatalogSyncPlan {
  version: string;
  updatedAt: string;
  products: Product[];
  metaDoc: MigratedCatalogMetaDoc;
  chunkDocs: Array<{ chunkId: string; data: MigratedCatalogChunkDoc }>;
  staleChunkIds: string[];
  changedProductDocs: Array<{ productId: string; data: MigratedProductDoc }>;
  deletedProductIds: string[];
  batches: FirestoreSyncBatchOp[][];
  errors: string[];
}

export interface FirestoreSyncAdapter {
  getDocFromServer: (
    collectionName: string,
    docId: string
  ) => Promise<{ exists: boolean; data: Record<string, unknown> | undefined }>;
  commitBatch: (ops: FirestoreSyncBatchOp[]) => Promise<void>;
}

export interface CatalogMutationInput {
  upsertProducts?: Product[];
  deleteProductIds?: string[];
  socialLinksOverride?: SocialLink[];
  storeInfoOverride?: StoreInfo;
  fallbackProducts?: Product[];
  fallbackStoreInfo?: StoreInfo;
  fallbackSocialLinks?: SocialLink[];
}

export interface CatalogSyncCommitResult {
  version: string;
  updatedAt: string;
  productCount: number;
  chunkIds: string[];
  staleChunksDeleted: string[];
  batchesCommitted: number;
  products: Product[];
  storeInfo: StoreInfo;
  socialLinks: SocialLink[];
}

export function createNextCatalogVersion(
  previousVersion?: string | null,
  nowMs = Date.now()
): string {
  const candidate = `v1.${Math.max(1, Math.floor(nowMs))}`;
  if (candidate === previousVersion) {
    return `v1.${Math.max(1, Math.floor(nowMs)) + 1}`;
  }
  return candidate;
}

export function generateValidProductId(category: ProductCategory): string {
  const prefix = category.slice(0, 2).replace(/[^a-zA-Z0-9]/g, 'p') || 'pr';
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${prefix}-${rand}`;
}

function clampString(val: string, maxLen: number): string {
  return val.length > maxLen ? val.slice(0, maxLen).trim() : val;
}

export function sanitizeStoreInfoStrict(raw: unknown): {
  storeInfo: StoreInfo;
  errors: string[];
} {
  const errors: string[] = [];
  const src =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Partial<StoreInfo>)
      : FALLBACK_STORE_INFO;

  const agencyName = clampString(
    (typeof src.agencyName === 'string' && src.agencyName.trim()) ||
      FALLBACK_STORE_INFO.agencyName,
    120
  );
  const locationText = clampString(
    (typeof src.locationText === 'string' && src.locationText.trim()) ||
      FALLBACK_STORE_INFO.locationText,
    240
  );
  const city = clampString(
    (typeof src.city === 'string' && src.city.trim()) || FALLBACK_STORE_INFO.city,
    100
  );
  const guaranteeTitle = clampString(
    (typeof src.guaranteeTitle === 'string' && src.guaranteeTitle.trim()) ||
      FALLBACK_STORE_INFO.guaranteeTitle,
    200
  );
  const guaranteeText = clampString(
    (typeof src.guaranteeText === 'string' && src.guaranteeText.trim()) ||
      FALLBACK_STORE_INFO.guaranteeText,
    600
  );
  const freeDeliveryThresholdIqd =
    typeof src.freeDeliveryThresholdIqd === 'number' &&
    Number.isFinite(src.freeDeliveryThresholdIqd) &&
    src.freeDeliveryThresholdIqd >= 0
      ? Math.round(src.freeDeliveryThresholdIqd)
      : FALLBACK_STORE_INFO.freeDeliveryThresholdIqd;
  const standardDeliveryFeeIqd =
    typeof src.standardDeliveryFeeIqd === 'number' &&
    Number.isFinite(src.standardDeliveryFeeIqd) &&
    src.standardDeliveryFeeIqd >= 0
      ? Math.round(src.standardDeliveryFeeIqd)
      : FALLBACK_STORE_INFO.standardDeliveryFeeIqd;

  if (agencyName.length < 2 || locationText.length < 2 || city.length < 2) {
    errors.push('بيانات المتجر الأساسية غير مكتملة لتحديث catalog_meta/public.');
  }

  return {
    storeInfo: {
      agencyName,
      locationText,
      city,
      freeDeliveryThresholdIqd,
      standardDeliveryFeeIqd,
      guaranteeTitle,
      guaranteeText,
    },
    errors,
  };
}

export function sanitizeSocialLinksStrict(raw: unknown): SocialLink[] {
  if (!Array.isArray(raw)) return [];
  const out: SocialLink[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Partial<SocialLink>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const platform = typeof rec.platform === 'string' ? rec.platform.trim() : '';
    const label = typeof rec.label === 'string' ? rec.label.trim() : platform;
    const handle = typeof rec.handle === 'string' ? rec.handle.trim() : '';
    const url = typeof rec.url === 'string' ? sanitizeHref(rec.url) : '#';
    if (!id || !platform || !label) continue;
    out.push({ id, platform, label, handle, url });
  }
  return out;
}

/**
 * Sanitizes and strictly validates a single product against ALL deployed `firestore.rules`
 * constraints (`isValidProduct(data)`), preventing empty required strings, invalid IDs,
 * oversized fields, or extra keys from causing a batch rejection.
 */
export function sanitizeAndValidateProductForFirestore(
  raw: Product,
  updatedAt: string
): { docData: MigratedProductDoc | null; product: Product | null; errors: string[] } {
  const errors: string[] = [];

  const category: ProductCategory = VALID_CATEGORIES.has(raw.category)
    ? raw.category
    : 'blaugrana';
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const code = typeof raw.code === 'string' ? raw.code.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const brand =
    (typeof raw.brand === 'string' && raw.brand.trim()) || 'بلوكرانا';
  const size =
    (typeof raw.size === 'string' && raw.size.trim()) || '100 مل';
  const longevity =
    (typeof raw.longevity === 'string' && raw.longevity.trim()) || '24 ساعة';
  const sillage =
    (typeof raw.sillage === 'string' && raw.sillage.trim()) || 'فوحان ممتاز';

  const topNotes =
    typeof raw.topNotes === 'string' && raw.topNotes.trim()
      ? clampString(raw.topNotes.trim(), 240)
      : undefined;
  const heartNotes =
    typeof raw.heartNotes === 'string' && raw.heartNotes.trim()
      ? clampString(raw.heartNotes.trim(), 240)
      : undefined;
  const baseNotes =
    typeof raw.baseNotes === 'string' && raw.baseNotes.trim()
      ? clampString(raw.baseNotes.trim(), 240)
      : undefined;

  const combinedNotes = [topNotes, heartNotes, baseNotes].filter(Boolean).join(' · ');
  const notes = clampString(
    (typeof raw.notes === 'string' && raw.notes.trim()) ||
      combinedNotes ||
      'تركيبة عطرية فاخرة من وكالة بلوكرانا.',
    600
  );
  const description = clampString(
    (typeof raw.description === 'string' && raw.description.trim()) ||
      'منتج أصلي من وكالة بلوكرانا بضمان الثبات والفوحان.',
    1000
  );

  const rawImg = typeof raw.imageUrl === 'string' ? raw.imageUrl.trim() : '';
  if (rawImg.startsWith('data:image/') || rawImg.length > 1000) {
    errors.push(
      `رابط صورة العطر (${code || name || id}) يتجاوز 1000 حرف أو بصيغة Base64 غير مدعومة في Firestore؛ يرجى رفع الصورة عبر أداة الرفع أو استخدام رابط مباشر.`
    );
  }
  const sanitizedImg = rawImg
    ? sanitizeImageInput(rawImg)
    : DEFAULT_CATEGORY_IMAGES[category];
  const imageUrl = sanitizedImg || DEFAULT_CATEGORY_IMAGES[category];

  let priceIqd =
    typeof raw.priceIqd === 'number' && Number.isFinite(raw.priceIqd)
      ? Math.round(raw.priceIqd)
      : 0;

  let sizePrices: Record<string, number> | undefined;
  if (raw.sizePrices && typeof raw.sizePrices === 'object' && !Array.isArray(raw.sizePrices)) {
    const cleanPrices: Record<string, number> = {};
    for (const [sz, val] of Object.entries(raw.sizePrices)) {
      const k = sz.trim();
      const num = Math.round(Number(val));
      if (k && Number.isFinite(num) && num >= 500 && num <= 50_000_000) {
        cleanPrices[k] = num;
      }
    }
    const keys = Object.keys(cleanPrices);
    if (keys.length > 10) {
      errors.push(`عدد الأحجام للمنتج (${code || name}) يتجاوز الحد المسموح (10).`);
    } else if (keys.length > 0) {
      sizePrices = cleanPrices;
      if (typeof cleanPrices['100 مل'] === 'number') {
        priceIqd = cleanPrices['100 مل'];
      }
    }
  }

  if (!VALID_ID_REGEX.test(id)) {
    errors.push(`معرّف المنتج (${id || 'فارغ'}) غير مطابق لقواعد Firestore.`);
  }
  if (code.length < 1 || code.length > 64) {
    errors.push('يرجى إدخال رقم/كود عطر صحيح (1 إلى 64 حرفاً).');
  }
  if (name.length < 1 || name.length > 160) {
    errors.push('يرجى إدخال اسم عطر صحيح (1 إلى 160 حرفاً).');
  }
  if (brand.length < 1 || brand.length > 120) {
    errors.push('اسم العلامة التجارية يجب أن يكون بين 1 و 120 حرفاً.');
  }
  if (!Number.isInteger(priceIqd) || priceIqd < 500 || priceIqd > 50_000_000) {
    errors.push(`سعر المنتج (${code || name}) يجب أن يكون رقماً صحيحاً لا يقل عن 500 د.ع.`);
  }
  if (imageUrl.length < 1 || imageUrl.length > 1000) {
    errors.push('رابط الصورة غير صالح أو يتجاوز 1000 حرف.');
  }

  if (errors.length > 0) {
    return { docData: null, product: null, errors };
  }

  const includesFreeTester =
    typeof raw.includesFreeTester === 'boolean'
      ? raw.includesFreeTester
      : isQualifyingPerfumeCategory(category);
  const inStock = typeof raw.inStock === 'boolean' ? raw.inStock : true;
  const hasCustomImage =
    typeof raw.hasCustomImage === 'boolean'
      ? raw.hasCustomImage
      : imageUrl !== DEFAULT_CATEGORY_IMAGES.blaugrana;

  const product: Product = {
    id,
    code,
    name,
    brand,
    category,
    priceIqd,
    size: clampString(size, 40),
    ...(sizePrices ? { sizePrices } : {}),
    notes,
    ...(topNotes ? { topNotes } : {}),
    ...(heartNotes ? { heartNotes } : {}),
    ...(baseNotes ? { baseNotes } : {}),
    longevity: clampString(longevity, 80),
    sillage: clampString(sillage, 80),
    description,
    imageUrl,
    hasCustomImage,
    includesFreeTester,
    inStock,
  };

  const docData: MigratedProductDoc = {
    ...product,
    updatedAt,
  };

  return { docData, product, errors: [] };
}

export function applyCatalogMutation(
  baseProducts: Product[],
  mutation: { upsertProducts?: Product[]; deleteProductIds?: string[] }
): Product[] {
  const byId = new Map<string, Product>();
  for (const p of baseProducts) {
    if (p && typeof p.id === 'string' && p.id.trim()) {
      byId.set(p.id.trim(), p);
    }
  }
  for (const delId of mutation.deleteProductIds ?? []) {
    if (typeof delId === 'string' && delId.trim()) {
      byId.delete(delId.trim());
    }
  }
  for (const up of mutation.upsertProducts ?? []) {
    if (up && typeof up.id === 'string' && up.id.trim()) {
      byId.set(up.id.trim(), up);
    }
  }
  return Array.from(byId.values()).sort(compareProductsByCode);
}

/**
 * Derives consistent `products`, `catalog_chunks`, and `catalog_meta/public`
 * payloads from ONE authoritative product list, ensuring:
 * - Zero duplicate products (`Map<id, Product>`).
 * - Automatic deletion of stale trailing chunks when product count shrinks.
 * - Atomic batch grouping: if `totalOps <= 400`, everything commits in ONE WriteBatch;
 *   if `totalOps > 400`, product writes go first and ALL chunks + meta commit together
 *   in the final atomic barrier batch so customers NEVER see partial updates.
 */
export function buildCatalogSyncCommitPlan(params: {
  products: Product[];
  storeInfo: StoreInfo;
  socialLinks: SocialLink[];
  previousChunkIds?: string[];
  changedProductIds: string[];
  deletedProductIds?: string[];
  version: string;
  updatedAt?: string;
  chunkSize?: number;
}): FirestoreCatalogSyncPlan {
  const updatedAt = params.updatedAt ?? new Date().toISOString();
  const chunkSize = Math.min(
    150,
    Math.max(1, params.chunkSize ?? DEFAULT_MIGRATION_CHUNK_SIZE)
  );
  const errors: string[] = [];

  if (!VERSION_REGEX.test(params.version)) {
    errors.push('صيغة رقم الإصدار غير متوافقة مع قواعد Firestore.');
  }

  const { storeInfo, errors: storeErrors } = sanitizeStoreInfoStrict(params.storeInfo);
  errors.push(...storeErrors);
  const socialLinks = sanitizeSocialLinksStrict(params.socialLinks);

  const dedupedById = new Map<string, { product: Product; docData: MigratedProductDoc }>();
  for (const raw of params.products) {
    const res = sanitizeAndValidateProductForFirestore(raw, updatedAt);
    if (res.errors.length > 0 || !res.docData || !res.product) {
      errors.push(...res.errors);
      continue;
    }
    dedupedById.set(res.product.id, { product: res.product, docData: res.docData });
  }

  const sortedEntries = Array.from(dedupedById.values()).sort((a, b) =>
    compareProductsByCode(a.product, b.product)
  );
  const normalizedProducts = sortedEntries.map((e) => e.product);
  const normalizedDocs = sortedEntries.map((e) => e.docData);

  const chunkDocs: Array<{ chunkId: string; data: MigratedCatalogChunkDoc }> = [];
  const nextChunkIds: string[] = [];

  for (let i = 0; i < normalizedDocs.length; i += chunkSize) {
    const chunkIndex = chunkDocs.length;
    const chunkId = `chunk_${chunkIndex}`;
    nextChunkIds.push(chunkId);
    chunkDocs.push({
      chunkId,
      data: {
        chunkIndex,
        version: params.version,
        items: normalizedDocs.slice(i, i + chunkSize),
        updatedAt,
      },
    });
  }

  if (nextChunkIds.length > 30) {
    errors.push(
      `عدد الشرائح (${nextChunkIds.length}) يتجاوز الحد الأقصى في قواعد الأمان (30).`
    );
  }

  const nextChunkSet = new Set(nextChunkIds);
  const staleChunkIds = (params.previousChunkIds ?? []).filter(
    (cid) => VALID_CHUNK_ID_REGEX.test(cid) && !nextChunkSet.has(cid)
  );

  const metaDoc: MigratedCatalogMetaDoc = {
    version: params.version,
    productCount: normalizedProducts.length,
    chunkIds: nextChunkIds,
    storeInfo,
    socialLinks,
    updatedAt,
  };

  if (!measureFirestoreDocumentSize('catalog_meta/public', metaDoc).within1MiBLimit) {
    errors.push('حجم مستند catalog_meta/public يتجاوز حد Firestore البالغ 1 MiB.');
  }
  for (const c of chunkDocs) {
    if (!measureFirestoreDocumentSize(`catalog_chunks/${c.chunkId}`, c.data).within1MiBLimit) {
      errors.push(`حجم الشريحة catalog_chunks/${c.chunkId} يتجاوز حد 1 MiB.`);
    }
  }

  const deletedSet = new Set(
    (params.deletedProductIds ?? []).filter((id) => VALID_ID_REGEX.test(id))
  );
  const changedSet = new Set(
    params.changedProductIds.filter((id) => !deletedSet.has(id))
  );

  const changedProductDocs: Array<{ productId: string; data: MigratedProductDoc }> = [];
  for (const id of changedSet) {
    const entry = dedupedById.get(id);
    if (entry) {
      if (!measureFirestoreDocumentSize(`products/${id}`, entry.docData).within1MiBLimit) {
        errors.push(`حجم مستند المنتج products/${id} يتجاوز 1 MiB.`);
      }
      changedProductDocs.push({ productId: id, data: entry.docData });
    }
  }
  const deletedProductIds = Array.from(deletedSet);

  const productOps: FirestoreSyncBatchOp[] = [
    ...changedProductDocs.map((p) => ({
      type: 'set' as const,
      collectionName: 'products' as const,
      docId: p.productId,
      data: p.data,
    })),
    ...deletedProductIds.map((id) => ({
      type: 'delete' as const,
      collectionName: 'products' as const,
      docId: id,
    })),
  ];

  const barrierOps: FirestoreSyncBatchOp[] = [
    ...chunkDocs.map((c) => ({
      type: 'set' as const,
      collectionName: 'catalog_chunks' as const,
      docId: c.chunkId,
      data: c.data,
    })),
    ...staleChunkIds.map((cid) => ({
      type: 'delete' as const,
      collectionName: 'catalog_chunks' as const,
      docId: cid,
    })),
    {
      type: 'set' as const,
      collectionName: 'catalog_meta' as const,
      docId: CATALOG_META_DOC_ID,
      data: metaDoc,
    },
  ];

  const batches: FirestoreSyncBatchOp[][] = [];
  if (productOps.length + barrierOps.length <= FIRESTORE_SAFE_BATCH_SIZE) {
    // Single atomic WriteBatch for all single edits, adds, deletes, and bulk updates <= 400 ops
    batches.push([...productOps, ...barrierOps]);
  } else {
    // Split product mutations first, keeping ALL chunks + stale chunk deletes + meta
    // together inside the final atomic barrier batch.
    for (let i = 0; i < productOps.length; i += FIRESTORE_SAFE_BATCH_SIZE) {
      batches.push(productOps.slice(i, i + FIRESTORE_SAFE_BATCH_SIZE));
    }
    batches.push(barrierOps);
  }

  return {
    version: params.version,
    updatedAt,
    products: normalizedProducts,
    metaDoc,
    chunkDocs,
    staleChunkIds,
    changedProductDocs,
    deletedProductIds,
    batches,
    errors,
  };
}

export const defaultFirestoreSyncAdapter: FirestoreSyncAdapter = {
  async getDocFromServer(collectionName, docId) {
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
  async commitBatch(ops) {
    const batch = writeBatch(db);
    for (const op of ops) {
      const ref = doc(db, op.collectionName, op.docId);
      if (op.type === 'delete') {
        batch.delete(ref);
      } else {
        batch.set(ref, op.data as Record<string, unknown>);
      }
    }
    try {
      await batch.commit();
    } catch (error) {
      const firstPath = ops[0]
        ? `${ops[0].collectionName}/${ops[0].docId}`
        : `${CATALOG_META_COLLECTION}/${CATALOG_META_DOC_ID}`;
      handleFirestoreError(error, OperationType.WRITE, firstPath);
    }
  },
};

export async function fetchAuthoritativeCatalogFromFirestore(options: {
  adapter?: FirestoreSyncAdapter;
} = {}): Promise<{
  exists: boolean;
  version: string | null;
  productCount: number | null;
  updatedAt: string | null;
  chunkIds: string[];
  products: Product[];
  storeInfo: StoreInfo | null;
  socialLinks: SocialLink[];
}> {
  const adapter = options.adapter ?? defaultFirestoreSyncAdapter;
  const metaSnap = await adapter.getDocFromServer(
    CATALOG_META_COLLECTION,
    CATALOG_META_DOC_ID
  );

  if (!metaSnap.exists || !metaSnap.data) {
    return {
      exists: false,
      version: null,
      productCount: null,
      updatedAt: null,
      chunkIds: [],
      products: [],
      storeInfo: null,
      socialLinks: [],
    };
  }

  const metaData = metaSnap.data;
  const version = typeof metaData.version === 'string' ? metaData.version : null;
  const productCount =
    typeof metaData.productCount === 'number' ? metaData.productCount : null;
  const updatedAt =
    typeof metaData.updatedAt === 'string' ? metaData.updatedAt : null;
  const chunkIds = Array.isArray(metaData.chunkIds)
    ? metaData.chunkIds.filter(
        (cid): cid is string => typeof cid === 'string' && VALID_CHUNK_ID_REGEX.test(cid)
      )
    : [];

  const chunkSnaps = await Promise.all(
    chunkIds.map((cid) => adapter.getDocFromServer(CATALOG_CHUNKS_COLLECTION, cid))
  );

  const byId = new Map<string, Product>();
  for (const snap of chunkSnaps) {
    if (!snap.exists || !snap.data || !Array.isArray(snap.data.items)) continue;
    for (const item of snap.data.items) {
      if (item && typeof item === 'object' && typeof (item as Product).id === 'string') {
        const p = item as Product;
        byId.set(p.id, p);
      }
    }
  }

  return {
    exists: true,
    version,
    productCount,
    updatedAt,
    chunkIds,
    products: Array.from(byId.values()).sort(compareProductsByCode),
    storeInfo: (metaData.storeInfo as StoreInfo | undefined) ?? null,
    socialLinks: sanitizeSocialLinksStrict(metaData.socialLinks),
  };
}

/**
 * Authoritatively commits an admin catalog mutation (add / edit / bulk price / delete /
 * social link update) directly to live Firestore using the verified owner's Google Auth
 * session (`wwwomara6@gmail.com`). Never uses a Service Account or Worker.
 * Invalidates storefront cache ONLY after Firestore commits cleanly.
 */
export async function commitCatalogSyncToFirestore(
  mutation: CatalogMutationInput,
  options: {
    user?: User | null;
    adapter?: FirestoreSyncAdapter;
    skipCacheInvalidation?: boolean;
    nowMs?: number;
  } = {}
): Promise<CatalogSyncCommitResult> {
  const currentUser = options.user === undefined ? auth.currentUser : options.user;
  if (!isAuthorizedAdminUser(currentUser)) {
    throw new Error(
      `يجب تسجيل الدخول بحساب Google الموثق (${AUTHORIZED_ADMIN_EMAIL}) لحفظ تغييرات الكتالوج في Firestore.`
    );
  }

  const adapter = options.adapter ?? defaultFirestoreSyncAdapter;
  const live = await fetchAuthoritativeCatalogFromFirestore({ adapter });

  const baseProducts =
    live.exists && live.products.length > 0
      ? live.products
      : (mutation.fallbackProducts ?? []);
  const baseStoreInfo =
    mutation.storeInfoOverride ??
    live.storeInfo ??
    mutation.fallbackStoreInfo ??
    FALLBACK_STORE_INFO;
  const baseSocialLinks =
    mutation.socialLinksOverride ??
    (live.exists ? live.socialLinks : (mutation.fallbackSocialLinks ?? []));

  const nextProducts = applyCatalogMutation(baseProducts, {
    upsertProducts: mutation.upsertProducts,
    deleteProductIds: mutation.deleteProductIds,
  });

  const nowMs = options.nowMs ?? Date.now();
  const nextVersion = createNextCatalogVersion(live.version, nowMs);
  const updatedAt = new Date(nowMs).toISOString();

  // If Firestore wasn't seeded yet, also write all base products so Firestore stays complete
  const changedProductIds = !live.exists
    ? nextProducts.map((p) => p.id)
    : (mutation.upsertProducts ?? []).map((p) => p.id);

  const plan = buildCatalogSyncCommitPlan({
    products: nextProducts,
    storeInfo: baseStoreInfo,
    socialLinks: baseSocialLinks,
    previousChunkIds: live.chunkIds,
    changedProductIds,
    deletedProductIds: mutation.deleteProductIds ?? [],
    version: nextVersion,
    updatedAt,
  });

  if (plan.errors.length > 0) {
    throw new Error(plan.errors[0]);
  }

  let batchesCommitted = 0;
  for (const batchOps of plan.batches) {
    if (batchOps.length === 0) continue;
    await adapter.commitBatch(batchOps);
    batchesCommitted += 1;
  }

  if (!options.skipCacheInvalidation) {
    invalidateCatalogCache();
  }

  return {
    version: plan.version,
    updatedAt: plan.updatedAt,
    productCount: plan.products.length,
    chunkIds: plan.metaDoc.chunkIds,
    staleChunksDeleted: plan.staleChunkIds,
    batchesCommitted,
    products: plan.products,
    storeInfo: plan.metaDoc.storeInfo,
    socialLinks: plan.metaDoc.socialLinks,
  };
}
