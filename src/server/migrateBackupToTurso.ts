import crypto from 'node:crypto';
import {
  buildVoucherCode,
  normalizePhoneNumber,
  normalizePromoCode,
  type AdminNotification,
  type CustomPerfumeRequest,
  type LoyaltyProfile,
  type Order,
  type PromoCode,
} from '../utils/commerce.ts';
import {
  TursoStore,
  computeLoyaltyFromPerfumes,
  sha256Hex,
  type MigrationAuditRecord,
} from './tursoStore.ts';

export interface ProductionBackupEnvelope {
  schemaVersion?: number;
  exportedAt?: string;
  origin?: string;
  completenessNotes?: Record<string, unknown>;
  data?: {
    orders?: Order[];
    customRequests?: CustomPerfumeRequest[];
    notifications?: AdminNotification[];
    promoCodes?: PromoCode[];
    loyaltyProfiles?: {
      profilesWithActivity?: LoyaltyProfile[];
      indistinguishableZeroProfiles?: LoyaltyProfile[];
      failedPhones?: string[];
    };
    orderSequenceEstimate?: number;
    loyaltyCountReportedByDashboard?: number;
  };
  integrity?: {
    dataSectionSha256?: string;
    fileSha256?: string;
    hashAlgorithm?: string;
  };
}

export interface LoyaltyCrossCheckIssue {
  phone: string;
  ordersInBackup: number;
  qualifyingPerfumesFromOrders: number;
  profileOrdersCount: number;
  profileTotalQualifyingPerfumes: number;
}

export interface BackupValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  dataSectionSha256: string;
  normalized: {
    orders: Order[];
    customRequests: CustomPerfumeRequest[];
    notifications: AdminNotification[];
    promoCodes: PromoCode[];
    profilesWithActivity: LoyaltyProfile[];
    indistinguishableZeroProfiles: LoyaltyProfile[];
    safeOrderSequence: number;
    maxOrderNumberFound: number;
    reportedOldLoyaltyCount: number | null;
    uploadImagePathsFound: string[];
    crossCheckMismatches: LoyaltyCrossCheckIssue[];
  } | null;
}

export interface MigrationImportReport {
  ok: boolean;
  importedCounts: {
    ordersInserted: number;
    customRequestsInserted: number;
    notificationsInserted: number;
    promoCodesInserted: number;
    loyaltyProfilesWithActivityUpserted: number;
    loyaltyIndistinguishableZeroUpserted: number;
    totalOrdersInDb: number;
    totalCustomRequestsInDb: number;
    totalNotificationsInDb: number;
    totalPromoCodesInDb: number;
    totalLoyaltyInDb: number;
  };
  audit: MigrationAuditRecord;
  crossCheckMismatches: LoyaltyCrossCheckIssue[];
  warnings: string[];
}

export interface CutoverDeltaPlan {
  newOrders: Order[];
  newCustomRequests: CustomPerfumeRequest[];
  newNotifications: AdminNotification[];
  newPromoCodes: PromoCode[];
  requiresSecondImport: boolean;
  summary: string;
}

const VALID_LOYALTY_KEYS = [
  'phone',
  'totalQualifyingPerfumes',
  'stamps',
  'stampsRemainingForFree',
  'freePerfumesRedeemed',
  'voucherCode',
  'ordersCount',
] as const;

export function parseOrderNumericSuffix(orderNumber: string): number {
  const m = String(orderNumber ?? '').trim().toUpperCase().match(/^BG-(\d+)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export function validateStrictSevenFieldLoyalty(
  raw: unknown,
  label: string
): { profile: LoyaltyProfile | null; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { profile: null, errors: [`${label}: سجل ولاء غير صالح.`] };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of VALID_LOYALTY_KEYS) {
    if (!(key in obj)) {
      errors.push(`${label}: الحقل الإلزامي ${key} مفقود.`);
    }
  }
  const phone = normalizePhoneNumber(typeof obj.phone === 'string' ? obj.phone : '');
  const totalQualifyingPerfumes = Number(obj.totalQualifyingPerfumes);
  const stamps = Number(obj.stamps);
  const stampsRemainingForFree = Number(obj.stampsRemainingForFree);
  const freePerfumesRedeemed = Number(obj.freePerfumesRedeemed);
  const ordersCount = Number(obj.ordersCount);
  const voucherCode = typeof obj.voucherCode === 'string' ? obj.voucherCode.trim() : '';

  if (phone.length < 10) {
    errors.push(`${label}: رقم الهاتف غير صالح.`);
  }
  if (!Number.isInteger(totalQualifyingPerfumes) || totalQualifyingPerfumes < 0) {
    errors.push(`${label}: totalQualifyingPerfumes غير صالح.`);
  }
  if (!Number.isInteger(stamps) || stamps < 0 || stamps > 4) {
    errors.push(`${label}: stamps يجب أن يكون بين 0 و 4.`);
  }
  if (!Number.isInteger(stampsRemainingForFree) || stampsRemainingForFree < 1 || stampsRemainingForFree > 5) {
    errors.push(`${label}: stampsRemainingForFree يجب أن يكون بين 1 و 5.`);
  }
  if (!Number.isInteger(freePerfumesRedeemed) || freePerfumesRedeemed < 0) {
    errors.push(`${label}: freePerfumesRedeemed غير صالح.`);
  }
  if (!Number.isInteger(ordersCount) || ordersCount < 0) {
    errors.push(`${label}: ordersCount غير صالح.`);
  }
  if (!voucherCode) {
    errors.push(`${label}: voucherCode فارغ.`);
  }

  if (errors.length > 0) {
    return { profile: null, errors };
  }

  return {
    profile: {
      phone,
      totalQualifyingPerfumes,
      stamps,
      stampsRemainingForFree,
      freePerfumesRedeemed,
      voucherCode,
      ordersCount,
    },
    errors: [],
  };
}

export function validateBackupEnvelope(rawTextOrObj: string | ProductionBackupEnvelope): BackupValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: ProductionBackupEnvelope;

  if (typeof rawTextOrObj === 'string') {
    try {
      parsed = JSON.parse(rawTextOrObj) as ProductionBackupEnvelope;
    } catch {
      return {
        valid: false,
        errors: ['تعذر تحليل ملف النسخة الاحتياطية كـ JSON صالح.'],
        warnings: [],
        dataSectionSha256: '',
        normalized: null,
      };
    }
  } else {
    parsed = rawTextOrObj;
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.data) {
    return {
      valid: false,
      errors: ['هيكل النسخة الاحتياطية ناقص: القسم data مفقود.'],
      warnings: [],
      dataSectionSha256: '',
      normalized: null,
    };
  }

  // 1. Verify dataSectionSha256 & optional fileSha256
  const computedDataSha = sha256Hex(JSON.stringify(parsed.data));
  const declaredDataSha = parsed.integrity?.dataSectionSha256?.trim() ?? '';
  if (!declaredDataSha) {
    errors.push('بصمة التحقق integrity.dataSectionSha256 مفقودة من الملف.');
  } else if (computedDataSha !== declaredDataSha) {
    errors.push(
      `فشل تطابق بصمة dataSectionSha256 (المتوقع ${declaredDataSha.slice(0, 12)}... والمحسوب ${computedDataSha.slice(0, 12)}...).`
    );
  }

  if (parsed.integrity?.fileSha256) {
    const cloneForFileHash = {
      ...parsed,
      integrity: {
        ...parsed.integrity,
        fileSha256: undefined,
      },
    };
    delete cloneForFileHash.integrity.fileSha256;
    const computedFileSha = sha256Hex(JSON.stringify(cloneForFileHash));
    if (computedFileSha !== parsed.integrity.fileSha256) {
      errors.push('فشل تطابق بصمة fileSha256 الكلية للملف.');
    }
  }

  // 2. Validate Orders
  const ordersRaw = parsed.data.orders;
  if (!Array.isArray(ordersRaw)) {
    errors.push('القسم data.orders غير موجود أو ليس مصفوفة.');
  }
  const orders: Order[] = [];
  let maxOrderNumberFound = 0;
  for (let i = 0; i < (ordersRaw?.length ?? 0); i += 1) {
    const o = ordersRaw![i] as Order;
    if (
      !o ||
      typeof o.id !== 'string' ||
      typeof o.orderNumber !== 'string' ||
      typeof o.phone !== 'string' ||
      typeof o.createdAt !== 'string' ||
      !Array.isArray(o.items) ||
      !o.pricing ||
      !Array.isArray(o.statusHistory)
    ) {
      errors.push(`الطلب في الفهرس ${i} يفتقد حقولاً أساسية (id/orderNumber/phone/items/pricing/statusHistory).`);
      continue;
    }
    const suffix = parseOrderNumericSuffix(o.orderNumber);
    if (suffix > maxOrderNumberFound) maxOrderNumberFound = suffix;
    orders.push({
      ...o,
      phone: normalizePhoneNumber(o.phone),
      voucherCode: o.voucherCode || buildVoucherCode(o.phone),
    });
  }

  // 3. Validate Custom Requests
  const customRaw = parsed.data.customRequests;
  if (!Array.isArray(customRaw)) {
    errors.push('القسم data.customRequests غير موجود أو ليس مصفوفة.');
  }
  const customRequests: CustomPerfumeRequest[] = [];
  for (let i = 0; i < (customRaw?.length ?? 0); i += 1) {
    const r = customRaw![i] as CustomPerfumeRequest;
    if (
      !r ||
      typeof r.id !== 'string' ||
      typeof r.perfumeName !== 'string' ||
      typeof r.customerPhone !== 'string'
    ) {
      errors.push(`الطلب الخاص في الفهرس ${i} يفتقد حقولاً أساسية.`);
      continue;
    }
    customRequests.push({
      ...r,
      customerPhone: normalizePhoneNumber(r.customerPhone),
    });
  }

  // 4. Validate Notifications
  const notifRaw = parsed.data.notifications;
  if (!Array.isArray(notifRaw)) {
    errors.push('القسم data.notifications غير موجود أو ليس مصفوفة.');
  }
  const notifications: AdminNotification[] = [];
  for (let i = 0; i < (notifRaw?.length ?? 0); i += 1) {
    const n = notifRaw![i] as AdminNotification;
    if (!n || typeof n.id !== 'string' || typeof n.createdAt !== 'string') {
      errors.push(`الإشعار في الفهرس ${i} غير صالح.`);
      continue;
    }
    notifications.push(n);
  }

  // 5. Validate Promo Codes
  const promoRaw = parsed.data.promoCodes;
  if (!Array.isArray(promoRaw)) {
    errors.push('القسم data.promoCodes غير موجود أو ليس مصفوفة.');
  }
  const promoCodes: PromoCode[] = [];
  for (let i = 0; i < (promoRaw?.length ?? 0); i += 1) {
    const p = promoRaw![i] as PromoCode;
    if (
      !p ||
      typeof p.id !== 'string' ||
      typeof p.code !== 'string' ||
      !Number.isFinite(Number(p.discountValue))
    ) {
      errors.push(`كود الخصم في الفهرس ${i} غير صالح.`);
      continue;
    }
    promoCodes.push({
      ...p,
      code: normalizePromoCode(p.code),
      timesUsed: Number.isFinite(Number(p.timesUsed)) ? Math.max(0, Math.round(Number(p.timesUsed))) : 0,
    });
  }

  // 6. Validate Loyalty Profiles (v4 strict classification)
  const loyaltySection = parsed.data.loyaltyProfiles;
  if (!loyaltySection || typeof loyaltySection !== 'object') {
    errors.push('القسم data.loyaltyProfiles مفقود.');
  }
  const failedPhones = Array.isArray(loyaltySection?.failedPhones)
    ? loyaltySection!.failedPhones
    : [];
  if (failedPhones.length > 0) {
    errors.push(`تحتوي النسخة الاحتياطية على ${failedPhones.length} هواتف فاشلة أثناء التصدير.`);
  }

  const profilesWithActivity: LoyaltyProfile[] = [];
  const indistinguishableZeroProfiles: LoyaltyProfile[] = [];

  const rawWithActivity = Array.isArray(loyaltySection?.profilesWithActivity)
    ? loyaltySection!.profilesWithActivity
    : [];
  const rawZeros = Array.isArray(loyaltySection?.indistinguishableZeroProfiles)
    ? loyaltySection!.indistinguishableZeroProfiles
    : [];

  for (let i = 0; i < rawWithActivity.length; i += 1) {
    const res = validateStrictSevenFieldLoyalty(
      rawWithActivity[i],
      `profilesWithActivity[${i}]`
    );
    errors.push(...res.errors);
    if (res.profile) profilesWithActivity.push(res.profile);
  }

  for (let i = 0; i < rawZeros.length; i += 1) {
    const res = validateStrictSevenFieldLoyalty(
      rawZeros[i],
      `indistinguishableZeroProfiles[${i}]`
    );
    errors.push(...res.errors);
    if (res.profile) indistinguishableZeroProfiles.push(res.profile);
  }

  // 7. Order Sequence safe calculation (documented as estimated, never proven exact)
  const estimate = Number(parsed.data.orderSequenceEstimate ?? 1001);
  const safeOrderSequence = Math.max(
    1001,
    Number.isFinite(estimate) ? Math.trunc(estimate) : 1001,
    maxOrderNumberFound + 1
  );

  // 8. Cross-check Orders vs Loyalty Profiles
  const ordersByPhone = new Map<
    string,
    { count: number; qualifyingUnits: number }
  >();
  for (const o of orders) {
    const prev = ordersByPhone.get(o.phone) ?? { count: 0, qualifyingUnits: 0 };
    prev.count += 1;
    prev.qualifyingUnits += Number(o.pricing?.qualifyingPerfumeUnits ?? 0);
    ordersByPhone.set(o.phone, prev);
  }

  const loyaltyByPhone = new Map<string, LoyaltyProfile>();
  for (const p of [...profilesWithActivity, ...indistinguishableZeroProfiles]) {
    loyaltyByPhone.set(p.phone, p);
  }

  const crossCheckMismatches: LoyaltyCrossCheckIssue[] = [];
  for (const [phone, agg] of ordersByPhone.entries()) {
    const lp = loyaltyByPhone.get(phone);
    if (
      !lp ||
      lp.ordersCount !== agg.count ||
      lp.totalQualifyingPerfumes !== agg.qualifyingUnits
    ) {
      crossCheckMismatches.push({
        phone,
        ordersInBackup: agg.count,
        qualifyingPerfumesFromOrders: agg.qualifyingUnits,
        profileOrdersCount: lp?.ordersCount ?? -1,
        profileTotalQualifyingPerfumes: lp?.totalQualifyingPerfumes ?? -1,
      });
    }
  }

  if (crossCheckMismatches.length > 0) {
    warnings.push(
      `يوجد ${crossCheckMismatches.length} فرق في مطابقة أعداد الطلبات/الولاء بين جدول الطلبات وسجلات الولاء.`
    );
  }

  const reportedOldLoyaltyCount =
    typeof parsed.data.loyaltyCountReportedByDashboard === 'number'
      ? parsed.data.loyaltyCountReportedByDashboard
      : null;

  warnings.push(
    'قيمة orderSequence القديمة غير قابلة للاستخراج المباشر من الخادم القديم؛ العداد المحسوب تقدير آمن لمنع التصادم فقط.'
  );
  warnings.push(
    'اكتمال سجلات loyaltyByPhone القديمة غير قابل للإثبات عبر واجهات API، وقد تبقى مفاتيح يتيمة أو صفرية غير مميّزة خارج الاستخراج.'
  );

  const uploadImagePathsFound: string[] = [];
  const rawProductsMaybe = (parsed.data as Record<string, unknown>).products;
  if (Array.isArray(rawProductsMaybe)) {
    for (const prod of rawProductsMaybe as Array<{ imageUrl?: unknown }>) {
      if (typeof prod?.imageUrl === 'string' && prod.imageUrl.trim().startsWith('/uploads/')) {
        uploadImagePathsFound.push(prod.imageUrl.trim());
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    dataSectionSha256: computedDataSha,
    normalized:
      errors.length === 0
        ? {
            orders,
            customRequests,
            notifications,
            promoCodes,
            profilesWithActivity,
            indistinguishableZeroProfiles,
            safeOrderSequence,
            maxOrderNumberFound,
            reportedOldLoyaltyCount,
            uploadImagePathsFound,
            crossCheckMismatches,
          }
        : null,
  };
}

export async function importBackupToTurso(
  store: TursoStore,
  backupInput: string | ProductionBackupEnvelope,
  options?: {
    snapshotType?: MigrationAuditRecord['snapshotType'];
  }
): Promise<MigrationImportReport> {
  const validation = validateBackupEnvelope(backupInput);
  if (!validation.valid || !validation.normalized) {
    throw new Error(
      `رفض الاستيراد بسبب فشل التحقق من النسخة الاحتياطية:\n- ${validation.errors.join('\n- ')}`
    );
  }

  const data = validation.normalized;
  await store.ensureSchema();

  let ordersInserted = 0;
  let customRequestsInserted = 0;
  let notificationsInserted = 0;
  let promoCodesInserted = 0;
  let loyaltyProfilesWithActivityUpserted = 0;
  let loyaltyIndistinguishableZeroUpserted = 0;

  const nowIso = new Date().toISOString();
  const audit: MigrationAuditRecord = {
    importedAt: nowIso,
    snapshotType: options?.snapshotType ?? 'snapshot_1_staging',
    sourceSha256: validation.dataSectionSha256,
    orderSequenceAssigned: data.safeOrderSequence,
    orderSequenceSource: 'estimated_from_orders',
    orderSequenceExactnessProven: false,
    reportedOldLoyaltyCount: data.reportedOldLoyaltyCount,
    extractedProfilesWithActivityCount: data.profilesWithActivity.length,
    extractedIndistinguishableZeroCount: data.indistinguishableZeroProfiles.length,
    loyaltyCompletenessProven: false,
    notes: [
      'قيمة orderSequence القديمة تقديرية لمنع تصادم الأرقام وليست إثباتاً للقيمة الداخلية بالخادم القديم.',
      'سجلات loyaltyByPhone المعزولة غير الظاهرة في الطلبات أو الطلبات الخاصة تبقى غير مستخرجة وموثقة كنواقص.',
      ...validation.warnings,
    ],
  };

  const tx = await store.client.transaction('write');
  try {
    // 1. Orders (idempotent via ON CONFLICT(id) DO NOTHING and unique order_number check)
    for (const o of data.orders) {
      const trackingToken = crypto.randomBytes(32).toString('hex');
      const res = await tx.execute({
        sql: `INSERT INTO orders (
                id, order_number, tracking_token, phone, status, created_at, delivered_at, payload_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [
          o.id,
          o.orderNumber,
          trackingToken,
          o.phone,
          o.status,
          o.createdAt,
          o.deliveredAt ?? null,
          JSON.stringify(o),
        ],
      });
      ordersInserted += res.rowsAffected;
    }

    // 2. Custom Requests
    for (const r of data.customRequests) {
      const res = await tx.execute({
        sql: `INSERT INTO custom_requests (id, customer_phone, status, created_at, payload_json)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [
          r.id,
          r.customerPhone,
          r.status,
          r.createdAt,
          JSON.stringify(r),
        ],
      });
      customRequestsInserted += res.rowsAffected;
    }

    // 3. Notifications
    for (const n of data.notifications) {
      const res = await tx.execute({
        sql: `INSERT INTO notifications (id, created_at, type, read, payload_json)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [
          n.id,
          n.createdAt,
          n.type,
          n.read ? 1 : 0,
          JSON.stringify(n),
        ],
      });
      notificationsInserted += res.rowsAffected;
    }

    // 4. Promo Codes
    for (const p of data.promoCodes) {
      const res = await tx.execute({
        sql: `INSERT INTO promo_codes (
                id, code, owner_name, discount_type, discount_value,
                duration_days, expires_at, active, times_used, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [
          p.id,
          p.code,
          p.ownerName,
          p.discountType,
          p.discountValue,
          p.durationDays ?? null,
          p.expiresAt ?? null,
          p.active ? 1 : 0,
          p.timesUsed ?? 0,
          p.createdAt || nowIso,
        ],
      });
      promoCodesInserted += res.rowsAffected;
    }

    // 5. Loyalty Profiles (preserve both active and indistinguishableZeroProfiles faithfully)
    const upsertLoyalty = async (
      lp: LoyaltyProfile,
      classification: 'with_activity' | 'indistinguishable_zero'
    ) => {
      const normalized = computeLoyaltyFromPerfumes(
        lp.phone,
        lp.totalQualifyingPerfumes,
        lp.freePerfumesRedeemed,
        lp.ordersCount,
        lp.voucherCode
      );
      await tx.execute({
        sql: `INSERT INTO loyalty_profiles (
                phone, total_qualifying_perfumes, stamps, stamps_remaining_for_free,
                free_perfumes_redeemed, voucher_code, orders_count, classification, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(phone) DO UPDATE SET
                total_qualifying_perfumes = MAX(loyalty_profiles.total_qualifying_perfumes, excluded.total_qualifying_perfumes),
                stamps = CASE
                  WHEN excluded.total_qualifying_perfumes >= loyalty_profiles.total_qualifying_perfumes
                  THEN excluded.stamps ELSE loyalty_profiles.stamps END,
                stamps_remaining_for_free = CASE
                  WHEN excluded.total_qualifying_perfumes >= loyalty_profiles.total_qualifying_perfumes
                  THEN excluded.stamps_remaining_for_free ELSE loyalty_profiles.stamps_remaining_for_free END,
                free_perfumes_redeemed = MAX(loyalty_profiles.free_perfumes_redeemed, excluded.free_perfumes_redeemed),
                orders_count = MAX(loyalty_profiles.orders_count, excluded.orders_count),
                classification = excluded.classification,
                updated_at = excluded.updated_at`,
        args: [
          normalized.phone,
          normalized.totalQualifyingPerfumes,
          normalized.stamps,
          normalized.stampsRemainingForFree,
          normalized.freePerfumesRedeemed,
          normalized.voucherCode,
          normalized.ordersCount,
          classification,
          nowIso,
        ],
      });
    };

    for (const lp of data.profilesWithActivity) {
      await upsertLoyalty(lp, 'with_activity');
      loyaltyProfilesWithActivityUpserted += 1;
    }
    for (const lp of data.indistinguishableZeroProfiles) {
      await upsertLoyalty(lp, 'indistinguishable_zero');
      loyaltyIndistinguishableZeroUpserted += 1;
    }

    // 6. Monotonically advance order_sequence (never regress)
    const seqRes = await tx.execute({
      sql: `SELECT value FROM counters WHERE key = 'order_sequence'`,
      args: [],
    });
    const existingSeq = Number(seqRes.rows[0]?.value ?? 1001);
    const finalSeq = Math.max(existingSeq, data.safeOrderSequence);
    audit.orderSequenceAssigned = finalSeq;

    await tx.execute({
      sql: `INSERT INTO counters (key, value, updated_at)
            VALUES ('order_sequence', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = MAX(counters.value, excluded.value), updated_at = excluded.updated_at`,
      args: [finalSeq, nowIso],
    });

    await tx.execute({
      sql: `INSERT INTO server_settings (key, value_json, updated_at)
            VALUES ('migration_audit', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      args: [JSON.stringify(audit), nowIso],
    });

    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }

  const [ordersDb, customDb, notifDb, promoDb, loyaltyDb] = await Promise.all([
    store.listOrders(),
    store.listCustomRequests(),
    store.listNotifications(),
    store.listPromoCodes(),
    store.getLoyaltyCount(),
  ]);

  return {
    ok: true,
    importedCounts: {
      ordersInserted,
      customRequestsInserted,
      notificationsInserted,
      promoCodesInserted,
      loyaltyProfilesWithActivityUpserted,
      loyaltyIndistinguishableZeroUpserted,
      totalOrdersInDb: ordersDb.length,
      totalCustomRequestsInDb: customDb.length,
      totalNotificationsInDb: notifDb.length,
      totalPromoCodesInDb: promoDb.length,
      totalLoyaltyInDb: loyaltyDb,
    },
    audit,
    crossCheckMismatches: data.crossCheckMismatches,
    warnings: validation.warnings,
  };
}

/**
 * Computes exact non-duplicate delta items between an earlier Snapshot #1
 * (already tested/imported) and a later Snapshot #2 or post-publish capture,
 * supporting deterministic cutover reconciliation.
 */
export function reconcileCutoverSnapshots(
  baseline: ProductionBackupEnvelope,
  latest: ProductionBackupEnvelope
): CutoverDeltaPlan {
  const vBase = validateBackupEnvelope(baseline);
  const vLatest = validateBackupEnvelope(latest);
  if (!vBase.valid || !vBase.normalized) {
    throw new Error(`Snapshot المرجعي غير صالح: ${vBase.errors.join(', ')}`);
  }
  if (!vLatest.valid || !vLatest.normalized) {
    throw new Error(`Snapshot اللاحق غير صالح: ${vLatest.errors.join(', ')}`);
  }

  const baseOrderIds = new Set(vBase.normalized.orders.map((o) => o.id));
  const baseOrderNums = new Set(vBase.normalized.orders.map((o) => o.orderNumber.toUpperCase()));
  const newOrders = vLatest.normalized.orders.filter(
    (o) => !baseOrderIds.has(o.id) && !baseOrderNums.has(o.orderNumber.toUpperCase())
  );

  const baseReqIds = new Set(vBase.normalized.customRequests.map((r) => r.id));
  const newCustomRequests = vLatest.normalized.customRequests.filter(
    (r) => !baseReqIds.has(r.id)
  );

  const baseNotifIds = new Set(vBase.normalized.notifications.map((n) => n.id));
  const newNotifications = vLatest.normalized.notifications.filter(
    (n) => !baseNotifIds.has(n.id)
  );

  const basePromoIds = new Set(vBase.normalized.promoCodes.map((p) => p.id));
  const newPromoCodes = vLatest.normalized.promoCodes.filter(
    (p) => !basePromoIds.has(p.id)
  );

  const requiresSecondImport =
    newOrders.length > 0 ||
    newCustomRequests.length > 0 ||
    newNotifications.length > 0 ||
    newPromoCodes.length > 0;

  return {
    newOrders,
    newCustomRequests,
    newNotifications,
    newPromoCodes,
    requiresSecondImport,
    summary: requiresSecondImport
      ? `تم رصد فروقات للمصالحة: ${newOrders.length} طلب، ${newCustomRequests.length} طلب خاص، ${newPromoCodes.length} بروموكود، ${newNotifications.length} إشعار.`
      : 'لا توجد فروقات جديدة بين Snapshot #1 وSnapshot #2.',
  };
}
