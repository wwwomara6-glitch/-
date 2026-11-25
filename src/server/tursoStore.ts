import { createClient, type Client, type InArgs, type ResultSet } from '@libsql/client';
import crypto from 'node:crypto';
import {
  DEFAULT_STATUS_MESSAGES,
  buildOwnerOrderAlertMessage,
  buildVoucherCode,
  calculateCartSummary,
  compareProductsByCode,
  isPromoCodeValidNow,
  isQualifyingPerfumeCategory,
  normalizePhoneNumber,
  normalizePromoCode,
  sanitizeHref,
  sanitizeImageInput,
  type AdminNotification,
  type AppliedPromoPreview,
  type CustomPerfumeRequest,
  type CustomRequestStatus,
  type LoyaltyProfile,
  type Order,
  type OrderItem,
  type OrderStatus,
  type Product,
  type ProductCategory,
  type PromoCode,
  type PromoDiscountType,
  type SocialLink,
  type StoreInfo,
} from '../utils/commerce.ts';
import type { AdminCredential, TelegramAlertConfig } from './store.ts';

export const MAX_PRODUCT_IMAGE_BYTES = 1_572_864; // 1.5 MiB hard cap for Turso Hrana HTTP + Render 512MB RAM

export interface MigrationAuditRecord {
  importedAt: string;
  snapshotType: 'snapshot_1_staging' | 'snapshot_2_cutover' | 'manual';
  sourceSha256: string;
  orderSequenceAssigned: number;
  orderSequenceSource: 'estimated_from_orders';
  orderSequenceExactnessProven: false;
  reportedOldLoyaltyCount: number | null;
  extractedProfilesWithActivityCount: number;
  extractedIndistinguishableZeroCount: number;
  loyaltyCompletenessProven: false;
  notes: string[];
}

export interface StoredProductImage {
  id: string;
  ext: 'jpg' | 'png' | 'webp';
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  sha256: string;
  sizeBytes: number;
  data: Uint8Array;
  createdAt: string;
}

export interface ExportedOperationalState {
  schemaVersion: 1;
  exportedAt: string;
  storageEngine: 'turso';
  data: {
    orders: Order[];
    customRequests: CustomPerfumeRequest[];
    notifications: AdminNotification[];
    promoCodes: PromoCode[];
    loyaltyProfiles: LoyaltyProfile[];
    orderSequence: number;
    writeFreeze: boolean;
    migrationAudit: MigrationAuditRecord | null;
  };
  integrity: {
    dataSectionSha256: string;
  };
}

export class WriteFreezeError extends Error {
  readonly code = 'MAINTENANCE_FREEZE';
  constructor(message = 'المتجر في وضع الصيانة المؤقتة حالياً لتحديث البيانات، يرجى المحاولة بعد قليل.') {
    super(message);
  }
}

export class StoreValidationError extends Error {
  readonly statusCode: number;
  readonly errors?: Record<string, string>;
  constructor(statusCode: number, message: string, errors?: Record<string, string>) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
  }
}

interface SqlExecutor {
  execute(stmt: { sql: string; args?: InArgs } | string): Promise<ResultSet>;
}

/**
 * Safety guard ensuring tests never accidentally connect to or mutate a
 * production Turso database.
 */
export function assertSafeDatabaseTarget(
  url: string,
  options?: { isTestMode?: boolean }
): void {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('TURSO_DATABASE_URL is empty.');
  }
  const isTestMode =
    options?.isTestMode ??
    (process.env.NODE_ENV === 'test' || process.env.BLAUGRANA_TEST_MODE === '1');
  if (!isTestMode) return;

  if (trimmed === ':memory:' || trimmed.startsWith('file:')) {
    return;
  }

  const lower = trimmed.toLowerCase();
  const isMarkedTestOrStaging =
    lower.includes('-test') || lower.includes('-staging') || lower.includes('-dev');
  if (!isMarkedTestOrStaging) {
    throw new Error(
      `Refusing to run tests against non-test/non-local database URL: ${trimmed}`
    );
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hasValidImageMagicBytes(buf: Buffer, ext: string): boolean {
  if (buf.length < 12) return false;
  if (ext === 'jpg') {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (ext === 'png') {
    return (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    );
  }
  if (ext === 'webp') {
    return (
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

export function computeLoyaltyFromPerfumes(
  phone: string,
  totalQualifyingPerfumes: number,
  freePerfumesRedeemed: number,
  ordersCount: number,
  voucherCode?: string
): LoyaltyProfile {
  const normalizedPhone = normalizePhoneNumber(phone);
  const safeTotal = Math.max(0, Math.floor(totalQualifyingPerfumes));
  const stamps = safeTotal % 5;
  return {
    phone: normalizedPhone,
    totalQualifyingPerfumes: safeTotal,
    stamps,
    stampsRemainingForFree: 5 - stamps,
    freePerfumesRedeemed: Math.max(0, Math.floor(freePerfumesRedeemed)),
    voucherCode: voucherCode?.trim() || buildVoucherCode(normalizedPhone),
    ordersCount: Math.max(0, Math.floor(ordersCount)),
  };
}

export class TursoStore {
  readonly client: Client;
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;
  private readonly defaultOrderSequence: number;

  constructor(options: {
    url: string;
    authToken?: string;
    isTestMode?: boolean;
    defaultOrderSequence?: number;
  }) {
    assertSafeDatabaseTarget(options.url, { isTestMode: options.isTestMode });
    this.client = createClient({
      url: options.url,
      ...(options.authToken ? { authToken: options.authToken } : {}),
    });
    this.defaultOrderSequence = options.defaultOrderSequence ?? 1001;
  }

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    if (this.schemaPromise) return this.schemaPromise;

    this.schemaPromise = (async () => {
      const statements = [
        `CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          order_number TEXT NOT NULL UNIQUE,
          tracking_token TEXT NOT NULL,
          phone TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          delivered_at TEXT,
          payload_json TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone)`,
        `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC)`,
        `CREATE TABLE IF NOT EXISTS custom_requests (
          id TEXT PRIMARY KEY,
          customer_phone TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_custom_requests_created ON custom_requests(created_at DESC)`,
        `CREATE TABLE IF NOT EXISTS loyalty_profiles (
          phone TEXT PRIMARY KEY,
          total_qualifying_perfumes INTEGER NOT NULL DEFAULT 0,
          stamps INTEGER NOT NULL DEFAULT 0,
          stamps_remaining_for_free INTEGER NOT NULL DEFAULT 5,
          free_perfumes_redeemed INTEGER NOT NULL DEFAULT 0,
          voucher_code TEXT NOT NULL,
          orders_count INTEGER NOT NULL DEFAULT 0,
          classification TEXT NOT NULL DEFAULT 'runtime',
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS promo_codes (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          owner_name TEXT NOT NULL,
          discount_type TEXT NOT NULL,
          discount_value INTEGER NOT NULL,
          duration_days INTEGER,
          expires_at TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          times_used INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          type TEXT NOT NULL,
          read INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC)`,
        `CREATE TABLE IF NOT EXISTS counters (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS server_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS catalog_mirror (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS product_images (
          id TEXT PRIMARY KEY,
          ext TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          data_blob BLOB NOT NULL,
          created_at TEXT NOT NULL
        )`,
      ];

      for (const sql of statements) {
        await this.client.execute(sql);
      }

      const nowIso = new Date().toISOString();
      await this.client.execute({
        sql: `INSERT OR IGNORE INTO counters (key, value, updated_at) VALUES (?, ?, ?)`,
        args: ['order_sequence', this.defaultOrderSequence, nowIso],
      });

      this.schemaReady = true;
    })();

    try {
      await this.schemaPromise;
    } catch (err) {
      this.schemaPromise = null;
      throw err;
    }
  }

  async close(): Promise<void> {
    this.client.close();
  }

  async ping(): Promise<boolean> {
    await this.ensureSchema();
    const res = await this.client.execute('SELECT 1 AS ok');
    return res.rows.length === 1;
  }

  private async getSetting<T>(
    key: string,
    exec: SqlExecutor = this.client
  ): Promise<T | null> {
    const res = await exec.execute({
      sql: `SELECT value_json FROM server_settings WHERE key = ?`,
      args: [key],
    });
    const raw = res.rows[0]?.value_json;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async setSetting(
    key: string,
    value: unknown,
    exec: SqlExecutor = this.client
  ): Promise<void> {
    await exec.execute({
      sql: `INSERT INTO server_settings (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      args: [key, JSON.stringify(value), new Date().toISOString()],
    });
  }

  async isWriteFrozen(exec?: SqlExecutor): Promise<boolean> {
    if ((process.env.WRITE_FREEZE_DEFAULT ?? '').trim().toLowerCase() === 'true') {
      return true;
    }
    await this.ensureSchema();
    const flag = await this.getSetting<{ frozen?: boolean }>('write_freeze', exec ?? this.client);
    return Boolean(flag?.frozen);
  }

  async setWriteFreeze(frozen: boolean, reason?: string): Promise<{ frozen: boolean; updatedAt: string; reason: string }> {
    await this.ensureSchema();
    const state = {
      frozen,
      reason: reason?.trim() || (frozen ? 'تجميد صيانة يدوي' : 'تشغيل طبيعي'),
      updatedAt: new Date().toISOString(),
    };
    await this.setSetting('write_freeze', state);
    return state;
  }

  async assertWritable(exec?: SqlExecutor): Promise<void> {
    if (await this.isWriteFrozen(exec)) {
      throw new WriteFreezeError();
    }
  }

  async getOrCreateSessionSecret(): Promise<string> {
    const envSecret = (process.env.SESSION_SECRET ?? '').trim();
    if (envSecret.length >= 16) return envSecret;

    await this.ensureSchema();
    const saved = await this.getSetting<{ secret?: string }>('session_secret');
    if (saved?.secret && saved.secret.length >= 16) {
      return saved.secret;
    }

    const generated = crypto.randomBytes(32).toString('hex');
    await this.client.execute({
      sql: `INSERT OR IGNORE INTO server_settings (key, value_json, updated_at) VALUES (?, ?, ?)`,
      args: ['session_secret', JSON.stringify({ secret: generated }), new Date().toISOString()],
    });
    const finalSaved = await this.getSetting<{ secret?: string }>('session_secret');
    return finalSaved?.secret || generated;
  }

  async getAdminCredential(): Promise<AdminCredential | null> {
    await this.ensureSchema();
    return this.getSetting<AdminCredential>('admin_credential');
  }

  async claimAdminCredential(cred: AdminCredential): Promise<boolean> {
    await this.ensureSchema();
    await this.assertWritable();
    const tx = await this.client.transaction('write');
    try {
      const existing = await this.getSetting<AdminCredential>('admin_credential', tx);
      if (existing) {
        await tx.rollback();
        return false;
      }
      await this.setSetting('admin_credential', cred, tx);
      await tx.commit();
      return true;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  async getTelegramConfig(): Promise<TelegramAlertConfig | null> {
    await this.ensureSchema();
    return this.getSetting<TelegramAlertConfig>('telegram_config');
  }

  async setTelegramConfig(config: TelegramAlertConfig | null): Promise<void> {
    await this.ensureSchema();
    await this.assertWritable();
    if (!config) {
      await this.client.execute({
        sql: `DELETE FROM server_settings WHERE key = 'telegram_config'`,
        args: [],
      });
      return;
    }
    await this.setSetting('telegram_config', config);
  }

  async getOrderSequence(): Promise<number> {
    await this.ensureSchema();
    const res = await this.client.execute({
      sql: `SELECT value FROM counters WHERE key = 'order_sequence'`,
      args: [],
    });
    const v = Number(res.rows[0]?.value ?? this.defaultOrderSequence);
    return Number.isFinite(v) && v >= 1001 ? Math.trunc(v) : this.defaultOrderSequence;
  }

  async getMigrationAudit(): Promise<MigrationAuditRecord | null> {
    await this.ensureSchema();
    return this.getSetting<MigrationAuditRecord>('migration_audit');
  }

  async setMigrationAudit(audit: MigrationAuditRecord): Promise<void> {
    await this.ensureSchema();
    await this.setSetting('migration_audit', audit);
  }

  // Loyalty lookup: read-only, synthesizes 0-profile without persisting unless an order completes
  async getLoyaltyByPhone(rawPhone: string): Promise<LoyaltyProfile> {
    await this.ensureSchema();
    const normalized = normalizePhoneNumber(rawPhone);
    const res = await this.client.execute({
      sql: `SELECT * FROM loyalty_profiles WHERE phone = ?`,
      args: [normalized],
    });
    const row = res.rows[0];
    if (!row) {
      return computeLoyaltyFromPerfumes(normalized, 0, 0, 0);
    }
    return {
      phone: String(row.phone),
      totalQualifyingPerfumes: Number(row.total_qualifying_perfumes ?? 0),
      stamps: Number(row.stamps ?? 0),
      stampsRemainingForFree: Number(row.stamps_remaining_for_free ?? 5),
      freePerfumesRedeemed: Number(row.free_perfumes_redeemed ?? 0),
      voucherCode: String(row.voucher_code ?? buildVoucherCode(normalized)),
      ordersCount: Number(row.orders_count ?? 0),
    };
  }

  async getLoyaltyCount(): Promise<number> {
    await this.ensureSchema();
    const res = await this.client.execute(`SELECT COUNT(*) AS cnt FROM loyalty_profiles`);
    return Number(res.rows[0]?.cnt ?? 0);
  }

  async listLoyaltyProfiles(): Promise<LoyaltyProfile[]> {
    await this.ensureSchema();
    const res = await this.client.execute(
      `SELECT * FROM loyalty_profiles ORDER BY orders_count DESC, phone ASC`
    );
    return res.rows.map((row) => ({
      phone: String(row.phone),
      totalQualifyingPerfumes: Number(row.total_qualifying_perfumes ?? 0),
      stamps: Number(row.stamps ?? 0),
      stampsRemainingForFree: Number(row.stamps_remaining_for_free ?? 5),
      freePerfumesRedeemed: Number(row.free_perfumes_redeemed ?? 0),
      voucherCode: String(row.voucher_code),
      ordersCount: Number(row.orders_count ?? 0),
    }));
  }

  // Orders & Tracking
  async trackOrder(orderNumberRaw: string, phoneRaw: string): Promise<Order | null> {
    await this.ensureSchema();
    const normalizedPhone = normalizePhoneNumber(phoneRaw);
    const orderNumber = orderNumberRaw.trim().toUpperCase();
    const res = await this.client.execute({
      sql: `SELECT payload_json FROM orders WHERE UPPER(order_number) = ? AND phone = ? LIMIT 1`,
      args: [orderNumber, normalizedPhone],
    });
    const raw = res.rows[0]?.payload_json;
    if (typeof raw !== 'string') return null;
    return JSON.parse(raw) as Order;
  }

  async listOrders(): Promise<Order[]> {
    await this.ensureSchema();
    const res = await this.client.execute(
      `SELECT payload_json FROM orders ORDER BY created_at DESC`
    );
    return res.rows.map((r) => JSON.parse(String(r.payload_json)) as Order);
  }

  async updateOrderStatus(
    orderId: string,
    patch: {
      status: OrderStatus;
      estimatedArrival?: string;
      statusMessage?: string;
    }
  ): Promise<Order | null> {
    await this.ensureSchema();
    await this.assertWritable();

    const tx = await this.client.transaction('write');
    try {
      const res = await tx.execute({
        sql: `SELECT payload_json FROM orders WHERE id = ?`,
        args: [orderId],
      });
      const raw = res.rows[0]?.payload_json;
      if (typeof raw !== 'string') {
        await tx.rollback();
        return null;
      }
      const order = JSON.parse(raw) as Order;
      const nowIso = new Date().toISOString();
      const prevStatus = order.status;
      order.status = patch.status;

      if (patch.estimatedArrival?.trim()) {
        order.estimatedArrival = patch.estimatedArrival.trim();
      }
      if (patch.statusMessage?.trim()) {
        order.statusMessage = patch.statusMessage.trim();
      } else if (prevStatus !== patch.status) {
        order.statusMessage = DEFAULT_STATUS_MESSAGES[patch.status];
      }
      if (patch.status === 'تم التسليم' && !order.deliveredAt) {
        order.deliveredAt = nowIso;
      }
      if (!Array.isArray(order.statusHistory)) {
        order.statusHistory = [{ status: prevStatus, timestamp: order.createdAt }];
      }
      if (prevStatus !== patch.status || Boolean(patch.statusMessage?.trim())) {
        order.statusHistory.push({
          status: patch.status,
          timestamp: nowIso,
          note: order.statusMessage,
        });
      }

      await tx.execute({
        sql: `UPDATE orders SET status = ?, delivered_at = ?, payload_json = ? WHERE id = ?`,
        args: [
          order.status,
          order.deliveredAt ?? null,
          JSON.stringify(order),
          order.id,
        ],
      });
      await tx.commit();
      return order;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  async createOrderAtomic(input: {
    fullName: string;
    exactLocation: string;
    birthDate: string;
    phone: string;
    promoCode?: string;
    resolvedCart: Array<{
      product: Product;
      selectedSize: string;
      unitPriceIqd: number;
      quantity: number;
    }>;
    testHooks?: {
      beforeCommit?: () => void;
    };
  }): Promise<{
    order: Order;
    loyalty: LoyaltyProfile;
    notification: AdminNotification;
  }> {
    await this.ensureSchema();
    const tx = await this.client.transaction('write');
    try {
      await this.assertWritable(tx);

      const normalizedPhone = normalizePhoneNumber(input.phone);
      const rawPromoCode = input.promoCode ? normalizePromoCode(input.promoCode) : '';

      let appliedPromo: AppliedPromoPreview | null = null;
      let matchedPromoId: string | null = null;

      if (rawPromoCode) {
        const promoRow = await tx.execute({
          sql: `SELECT * FROM promo_codes WHERE UPPER(code) = ? LIMIT 1`,
          args: [rawPromoCode],
        });
        const row = promoRow.rows[0];
        if (!row) {
          throw new StoreValidationError(400, 'كود الخصم المدخل غير صحيح أو غير مفعّل.');
        }
        const promoObj: PromoCode = {
          id: String(row.id),
          code: String(row.code),
          ownerName: String(row.owner_name),
          discountType: row.discount_type === 'fixed' ? 'fixed' : 'percent',
          discountValue: Number(row.discount_value),
          durationDays: row.duration_days !== null ? Number(row.duration_days) : null,
          expiresAt: row.expires_at ? String(row.expires_at) : null,
          active: Number(row.active) === 1,
          timesUsed: Number(row.times_used ?? 0),
          createdAt: String(row.created_at),
        };
        const validity = isPromoCodeValidNow(promoObj);
        if (validity.expired) {
          throw new StoreValidationError(410, 'انتهت صلاحية كود الخصم هذا.');
        }
        if (!promoObj.active) {
          throw new StoreValidationError(400, 'كود الخصم متوقف حالياً.');
        }
        matchedPromoId = promoObj.id;
        appliedPromo = {
          code: promoObj.code,
          ownerName: promoObj.ownerName,
          discountType: promoObj.discountType,
          discountValue: promoObj.discountValue,
          expiresAt: promoObj.expiresAt ?? null,
        };
      }

      const loyaltyRowRes = await tx.execute({
        sql: `SELECT * FROM loyalty_profiles WHERE phone = ?`,
        args: [normalizedPhone],
      });
      const loyaltyRow = loyaltyRowRes.rows[0];
      const priorProfile: LoyaltyProfile = loyaltyRow
        ? {
            phone: String(loyaltyRow.phone),
            totalQualifyingPerfumes: Number(loyaltyRow.total_qualifying_perfumes ?? 0),
            stamps: Number(loyaltyRow.stamps ?? 0),
            stampsRemainingForFree: Number(loyaltyRow.stamps_remaining_for_free ?? 5),
            freePerfumesRedeemed: Number(loyaltyRow.free_perfumes_redeemed ?? 0),
            voucherCode: String(loyaltyRow.voucher_code ?? buildVoucherCode(normalizedPhone)),
            ordersCount: Number(loyaltyRow.orders_count ?? 0),
          }
        : computeLoyaltyFromPerfumes(normalizedPhone, 0, 0, 0);

      const pricing = calculateCartSummary(
        input.resolvedCart.map((c) => ({
          product: c.product,
          selectedSize: c.selectedSize,
          quantity: c.quantity,
        })),
        priorProfile.totalQualifyingPerfumes,
        appliedPromo
      );

      const seqRes = await tx.execute({
        sql: `SELECT value FROM counters WHERE key = 'order_sequence'`,
        args: [],
      });
      const currentSeq = Math.max(
        this.defaultOrderSequence,
        Number(seqRes.rows[0]?.value ?? this.defaultOrderSequence)
      );
      const nextSeq = currentSeq + 1;
      const nowIso = new Date().toISOString();

      await tx.execute({
        sql: `INSERT INTO counters (key, value, updated_at)
              VALUES ('order_sequence', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [nextSeq, nowIso],
      });

      const orderNumber = `BG-${currentSeq}`;
      const trackingToken = crypto.randomBytes(32).toString('hex');
      const orderItems: OrderItem[] = input.resolvedCart.map(
        ({ product, selectedSize, unitPriceIqd, quantity }) => ({
          productId: product.id,
          code: product.code,
          name: product.name,
          brand: product.brand,
          category: product.category,
          size: selectedSize,
          priceIqd: unitPriceIqd,
          quantity,
          includesFreeTester:
            product.includesFreeTester || isQualifyingPerfumeCategory(product.category),
        })
      );

      const voucherCode = priorProfile.voucherCode || buildVoucherCode(normalizedPhone);
      const newOrder: Order = {
        id: crypto.randomUUID(),
        orderNumber,
        createdAt: nowIso,
        fullName: input.fullName,
        exactLocation: input.exactLocation,
        birthDate: input.birthDate,
        phone: normalizedPhone,
        items: orderItems,
        pricing,
        voucherCode,
        status: 'تم الاستلام',
        estimatedArrival: 'خلال 24 إلى 48 ساعة',
        statusMessage: DEFAULT_STATUS_MESSAGES['تم الاستلام'],
        statusHistory: [
          {
            status: 'تم الاستلام',
            timestamp: nowIso,
            note: 'تم تأكيد استلام الطلب بنجاح وجاري تحويله للتجهيز.',
          },
        ],
      };

      const updatedLoyalty = computeLoyaltyFromPerfumes(
        normalizedPhone,
        priorProfile.totalQualifyingPerfumes + pricing.qualifyingPerfumeUnits,
        priorProfile.freePerfumesRedeemed + pricing.freePerfumeUnitsEarned,
        priorProfile.ordersCount + 1,
        voucherCode
      );

      if (matchedPromoId && pricing.promoDiscountIqd > 0) {
        await tx.execute({
          sql: `UPDATE promo_codes SET times_used = times_used + 1 WHERE id = ?`,
          args: [matchedPromoId],
        });
      }

      const ownerAlertText = buildOwnerOrderAlertMessage(newOrder);
      const itemsSummary = orderItems
        .map((it) => `#${it.code} ${it.name}${it.size ? ` (${it.size})` : ''} × ${it.quantity}`)
        .join('، ');

      const notification: AdminNotification = {
        id: crypto.randomUUID(),
        createdAt: nowIso,
        type: 'new_order',
        orderId: newOrder.id,
        orderNumber: newOrder.orderNumber,
        customerName: input.fullName,
        customerPhone: normalizedPhone,
        exactLocation: input.exactLocation,
        totalIqd: pricing.totalIqd,
        itemsSummary,
        message: ownerAlertText,
        read: false,
      };

      await tx.execute({
        sql: `INSERT INTO orders (id, order_number, tracking_token, phone, status, created_at, delivered_at, payload_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newOrder.id,
          newOrder.orderNumber,
          trackingToken,
          normalizedPhone,
          newOrder.status,
          newOrder.createdAt,
          null,
          JSON.stringify(newOrder),
        ],
      });

      await tx.execute({
        sql: `INSERT INTO loyalty_profiles (
                phone, total_qualifying_perfumes, stamps, stamps_remaining_for_free,
                free_perfumes_redeemed, voucher_code, orders_count, classification, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
              ON CONFLICT(phone) DO UPDATE SET
                total_qualifying_perfumes = excluded.total_qualifying_perfumes,
                stamps = excluded.stamps,
                stamps_remaining_for_free = excluded.stamps_remaining_for_free,
                free_perfumes_redeemed = excluded.free_perfumes_redeemed,
                voucher_code = excluded.voucher_code,
                orders_count = excluded.orders_count,
                classification = excluded.classification,
                updated_at = excluded.updated_at`,
        args: [
          updatedLoyalty.phone,
          updatedLoyalty.totalQualifyingPerfumes,
          updatedLoyalty.stamps,
          updatedLoyalty.stampsRemainingForFree,
          updatedLoyalty.freePerfumesRedeemed,
          updatedLoyalty.voucherCode,
          updatedLoyalty.ordersCount,
          nowIso,
        ],
      });

      await tx.execute({
        sql: `INSERT INTO notifications (id, created_at, type, read, payload_json)
              VALUES (?, ?, ?, 0, ?)`,
        args: [
          notification.id,
          notification.createdAt,
          notification.type,
          JSON.stringify(notification),
        ],
      });

      input.testHooks?.beforeCommit?.();
      await tx.commit();
      return { order: newOrder, loyalty: updatedLoyalty, notification };
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  // Custom Requests
  async listCustomRequests(): Promise<CustomPerfumeRequest[]> {
    await this.ensureSchema();
    const res = await this.client.execute(
      `SELECT payload_json FROM custom_requests ORDER BY created_at DESC`
    );
    return res.rows.map((r) => JSON.parse(String(r.payload_json)) as CustomPerfumeRequest);
  }

  async createCustomRequestAtomic(input: {
    perfumeName: string;
    expectedPriceIqd: number;
    size: string;
    desiredDate: string;
    customerName: string;
    customerPhone: string;
    notes: string;
  }): Promise<{ request: CustomPerfumeRequest; notification: AdminNotification }> {
    await this.ensureSchema();
    const tx = await this.client.transaction('write');
    try {
      await this.assertWritable(tx);
      const nowIso = new Date().toISOString();
      const normalizedPhone = normalizePhoneNumber(input.customerPhone);
      const created: CustomPerfumeRequest = {
        id: crypto.randomUUID(),
        createdAt: nowIso,
        perfumeName: input.perfumeName,
        expectedPriceIqd: Math.round(input.expectedPriceIqd),
        size: input.size,
        desiredDate: input.desiredDate,
        customerName: input.customerName,
        customerPhone: normalizedPhone,
        notes: input.notes,
        status: 'قيد البحث',
      };

      const alertText = [
        `✨ طلب «وفرلي عطري» جديد`,
        `🧴 العطر: ${created.perfumeName} (${created.size})`,
        `👤 الزبون: ${created.customerName}`,
        `📱 الهاتف: ${normalizedPhone}`,
        `💰 السعر المتوقع: ${created.expectedPriceIqd.toLocaleString('en-US')} د.ع`,
        `📅 التاريخ المطلوب: ${created.desiredDate}`,
      ].join('\n');

      const notification: AdminNotification = {
        id: crypto.randomUUID(),
        createdAt: nowIso,
        type: 'custom_request',
        customerName: created.customerName,
        customerPhone: normalizedPhone,
        itemsSummary: `وفرلي عطري: ${created.perfumeName} (${created.size})`,
        message: alertText,
        read: false,
      };

      await tx.execute({
        sql: `INSERT INTO custom_requests (id, customer_phone, status, created_at, payload_json)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          created.id,
          normalizedPhone,
          created.status,
          created.createdAt,
          JSON.stringify(created),
        ],
      });

      await tx.execute({
        sql: `INSERT INTO notifications (id, created_at, type, read, payload_json)
              VALUES (?, ?, ?, 0, ?)`,
        args: [
          notification.id,
          notification.createdAt,
          notification.type,
          JSON.stringify(notification),
        ],
      });

      await tx.commit();
      return { request: created, notification };
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  async updateCustomRequestStatus(
    id: string,
    status: CustomRequestStatus
  ): Promise<CustomPerfumeRequest | null> {
    await this.ensureSchema();
    await this.assertWritable();
    const res = await this.client.execute({
      sql: `SELECT payload_json FROM custom_requests WHERE id = ?`,
      args: [id],
    });
    const raw = res.rows[0]?.payload_json;
    if (typeof raw !== 'string') return null;
    const reqObj = JSON.parse(raw) as CustomPerfumeRequest;
    reqObj.status = status;
    await this.client.execute({
      sql: `UPDATE custom_requests SET status = ?, payload_json = ? WHERE id = ?`,
      args: [status, JSON.stringify(reqObj), id],
    });
    return reqObj;
  }

  // Notifications
  async listNotifications(): Promise<AdminNotification[]> {
    await this.ensureSchema();
    const res = await this.client.execute(
      `SELECT read, payload_json FROM notifications ORDER BY created_at DESC`
    );
    return res.rows.map((r) => {
      const parsed = JSON.parse(String(r.payload_json)) as AdminNotification;
      return { ...parsed, read: Number(r.read) === 1 || Boolean(parsed.read) };
    });
  }

  async markAllNotificationsRead(): Promise<AdminNotification[]> {
    await this.ensureSchema();
    await this.assertWritable();
    const list = await this.listNotifications();
    const tx = await this.client.transaction('write');
    try {
      for (const n of list) {
        const updated = { ...n, read: true };
        await tx.execute({
          sql: `UPDATE notifications SET read = 1, payload_json = ? WHERE id = ?`,
          args: [JSON.stringify(updated), n.id],
        });
      }
      await tx.commit();
      return list.map((n) => ({ ...n, read: true }));
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  // Promo Codes
  async listPromoCodes(): Promise<PromoCode[]> {
    await this.ensureSchema();
    const res = await this.client.execute(
      `SELECT * FROM promo_codes ORDER BY created_at DESC`
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      code: String(r.code),
      ownerName: String(r.owner_name),
      discountType: r.discount_type === 'fixed' ? 'fixed' : 'percent',
      discountValue: Number(r.discount_value),
      durationDays: r.duration_days !== null ? Number(r.duration_days) : null,
      expiresAt: r.expires_at ? String(r.expires_at) : null,
      active: Number(r.active) === 1,
      timesUsed: Number(r.times_used ?? 0),
      createdAt: String(r.created_at),
    }));
  }

  async findPromoByCode(rawCode: string): Promise<PromoCode | null> {
    await this.ensureSchema();
    const code = normalizePromoCode(rawCode);
    if (!code) return null;
    const res = await this.client.execute({
      sql: `SELECT * FROM promo_codes WHERE UPPER(code) = ? LIMIT 1`,
      args: [code],
    });
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      code: String(r.code),
      ownerName: String(r.owner_name),
      discountType: r.discount_type === 'fixed' ? 'fixed' : 'percent',
      discountValue: Number(r.discount_value),
      durationDays: r.duration_days !== null ? Number(r.duration_days) : null,
      expiresAt: r.expires_at ? String(r.expires_at) : null,
      active: Number(r.active) === 1,
      timesUsed: Number(r.times_used ?? 0),
      createdAt: String(r.created_at),
    };
  }

  async createPromoCode(promo: PromoCode): Promise<PromoCode> {
    await this.ensureSchema();
    await this.assertWritable();
    await this.client.execute({
      sql: `INSERT INTO promo_codes (
              id, code, owner_name, discount_type, discount_value,
              duration_days, expires_at, active, times_used, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        promo.id,
        promo.code,
        promo.ownerName,
        promo.discountType,
        promo.discountValue,
        promo.durationDays ?? null,
        promo.expiresAt ?? null,
        promo.active ? 1 : 0,
        promo.timesUsed ?? 0,
        promo.createdAt,
      ],
    });
    return promo;
  }

  async updatePromoCode(
    id: string,
    patch: {
      active?: boolean;
      ownerName?: string;
      durationDays?: number | null;
      expiresAt?: string | null;
    }
  ): Promise<PromoCode | null> {
    await this.ensureSchema();
    await this.assertWritable();
    const res = await this.client.execute({
      sql: `SELECT * FROM promo_codes WHERE id = ?`,
      args: [id],
    });
    const r = res.rows[0];
    if (!r) return null;

    const current: PromoCode = {
      id: String(r.id),
      code: String(r.code),
      ownerName: String(r.owner_name),
      discountType: r.discount_type === 'fixed' ? 'fixed' : 'percent',
      discountValue: Number(r.discount_value),
      durationDays: r.duration_days !== null ? Number(r.duration_days) : null,
      expiresAt: r.expires_at ? String(r.expires_at) : null,
      active: Number(r.active) === 1,
      timesUsed: Number(r.times_used ?? 0),
      createdAt: String(r.created_at),
    };

    const next: PromoCode = {
      ...current,
      ...(typeof patch.active === 'boolean' ? { active: patch.active } : {}),
      ...(patch.ownerName ? { ownerName: patch.ownerName } : {}),
      ...(patch.durationDays !== undefined ? { durationDays: patch.durationDays } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
    };

    await this.client.execute({
      sql: `UPDATE promo_codes
            SET owner_name = ?, duration_days = ?, expires_at = ?, active = ?
            WHERE id = ?`,
      args: [
        next.ownerName,
        next.durationDays ?? null,
        next.expiresAt ?? null,
        next.active ? 1 : 0,
        next.id,
      ],
    });
    return next;
  }

  async deletePromoCode(id: string): Promise<boolean> {
    await this.ensureSchema();
    await this.assertWritable();
    const res = await this.client.execute({
      sql: `DELETE FROM promo_codes WHERE id = ?`,
      args: [id],
    });
    return res.rowsAffected > 0;
  }

  // Catalog Mirror inside Turso (used only as fallback/reconciliation; Firestore Spark is primary)
  async getCatalogMirror(fallbackSeed?: {
    storeInfo: StoreInfo;
    products: Product[];
    socialLinks: SocialLink[];
  }): Promise<{
    storeInfo: StoreInfo;
    products: Product[];
    socialLinks: SocialLink[];
    deletedSeedIds: string[];
  }> {
    await this.ensureSchema();
    const res = await this.client.execute(`SELECT key, value_json FROM catalog_mirror`);
    const map = new Map<string, string>();
    for (const row of res.rows) {
      map.set(String(row.key), String(row.value_json));
    }
    const storeInfo = map.has('store_info')
      ? (JSON.parse(map.get('store_info')!) as StoreInfo)
      : fallbackSeed?.storeInfo ?? {
          agencyName: 'وكالة بلوكرانا للعطور',
          locationText: 'العراق - ديالى - بعقوبة - التحرير - شارع الحسينية',
          city: 'ديالى - بعقوبة',
          freeDeliveryThresholdIqd: 20000,
          standardDeliveryFeeIqd: 5000,
          guaranteeTitle: 'ضمان الثبات والفوحان الذهبي + تيستر مجاني مع كل عطر',
          guaranteeText:
            'كل عطر تطلبه من وكالة بلوكرانا يصلك مع عينة تيستر مجانية للتجربة قبل فتح العبوة الأصلية.',
        };
    const products = map.has('products')
      ? (JSON.parse(map.get('products')!) as Product[])
      : fallbackSeed?.products ?? [];
    const socialLinks = map.has('social_links')
      ? (JSON.parse(map.get('social_links')!) as SocialLink[])
      : fallbackSeed?.socialLinks ?? [];
    const deletedSeedIds = map.has('deleted_seed_ids')
      ? (JSON.parse(map.get('deleted_seed_ids')!) as string[])
      : [];
    return { storeInfo, products, socialLinks, deletedSeedIds };
  }

  async saveCatalogMirror(
    patch: {
      storeInfo?: StoreInfo;
      products?: Product[];
      socialLinks?: SocialLink[];
      deletedSeedIds?: string[];
    },
    exec: SqlExecutor = this.client
  ): Promise<void> {
    await this.ensureSchema();
    const nowIso = new Date().toISOString();
    const entries: Array<[string, unknown]> = [];
    if (patch.storeInfo) entries.push(['store_info', patch.storeInfo]);
    if (patch.products) entries.push(['products', patch.products]);
    if (patch.socialLinks) entries.push(['social_links', patch.socialLinks]);
    if (patch.deletedSeedIds) entries.push(['deleted_seed_ids', patch.deletedSeedIds]);

    for (const [k, val] of entries) {
      await exec.execute({
        sql: `INSERT INTO catalog_mirror (key, value_json, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        args: [k, JSON.stringify(val), nowIso],
      });
    }
  }

  async reconcileSyncPayloadToTurso(
    payload: {
      addedProducts?: unknown;
      updatedProducts?: unknown;
      deletedIds?: unknown;
      promoCodes?: unknown;
      deletedPromoIds?: unknown;
      socialLinks?: unknown;
    },
    seedFallback?: {
      storeInfo: StoreInfo;
      products: Product[];
      socialLinks: SocialLink[];
    }
  ): Promise<{
    syncedCount: number;
    products: Product[];
    promoCodes: PromoCode[];
    socialLinks: SocialLink[];
  }> {
    await this.ensureSchema();
    await this.assertWritable();

    const mirror = await this.getCatalogMirror(seedFallback);
    const validCategories = new Set<ProductCategory>([
      'blaugrana',
      'other_brands',
      'body_mist',
      'room_spray',
      'deodorant',
      'hair_care',
      'tester',
    ]);

    const addedProducts = Array.isArray(payload.addedProducts)
      ? (payload.addedProducts as Product[])
      : [];
    const updatedProducts = Array.isArray(payload.updatedProducts)
      ? (payload.updatedProducts as Product[])
      : [];
    const deletedIds = new Set<string>(
      Array.isArray(payload.deletedIds)
        ? payload.deletedIds.filter((id: unknown): id is string => typeof id === 'string')
        : []
    );
    const incomingPromos = Array.isArray(payload.promoCodes)
      ? (payload.promoCodes as PromoCode[])
      : [];
    const deletedPromoIds = new Set<string>(
      Array.isArray(payload.deletedPromoIds)
        ? payload.deletedPromoIds.filter((id: unknown): id is string => typeof id === 'string')
        : []
    );
    const incomingSocials = Array.isArray(payload.socialLinks)
      ? (payload.socialLinks as SocialLink[])
      : [];

    let syncedCount = 0;
    let nextProducts = [...mirror.products];
    const deletedSeedSet = new Set(mirror.deletedSeedIds);

    if (deletedIds.size > 0) {
      const before = nextProducts.length;
      nextProducts = nextProducts.filter((p) => !deletedIds.has(p.id));
      syncedCount += before - nextProducts.length;
      for (const id of deletedIds) deletedSeedSet.add(id);
    }

    for (const raw of addedProducts) {
      if (!raw || typeof raw.id !== 'string' || deletedIds.has(raw.id)) continue;
      if (nextProducts.some((p) => p.id === raw.id)) continue;
      const category = validCategories.has(raw.category) ? raw.category : 'blaugrana';
      const priceIqd =
        typeof raw.priceIqd === 'number' && Number.isFinite(raw.priceIqd) && raw.priceIqd >= 500
          ? Math.round(raw.priceIqd)
          : 30000;
      nextProducts.unshift({
        ...raw,
        category,
        priceIqd,
        imageUrl: sanitizeImageInput(raw.imageUrl),
        includesFreeTester:
          typeof raw.includesFreeTester === 'boolean'
            ? raw.includesFreeTester
            : isQualifyingPerfumeCategory(category),
        inStock: typeof raw.inStock === 'boolean' ? raw.inStock : true,
      });
      syncedCount += 1;
    }

    for (const raw of updatedProducts) {
      if (!raw || typeof raw.id !== 'string' || deletedIds.has(raw.id)) continue;
      const idx = nextProducts.findIndex((p) => p.id === raw.id);
      if (idx === -1) continue;
      const existing = nextProducts[idx];
      const category = validCategories.has(raw.category) ? raw.category : existing.category;
      const merged: Product = {
        ...existing,
        ...raw,
        category,
        imageUrl: sanitizeImageInput(raw.imageUrl ?? existing.imageUrl),
      };
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        nextProducts[idx] = merged;
        syncedCount += 1;
      }
    }

    nextProducts.sort(compareProductsByCode);

    const nextSocials = [...mirror.socialLinks];
    for (const rawSoc of incomingSocials) {
      if (!rawSoc || typeof rawSoc.id !== 'string' || typeof rawSoc.url !== 'string') continue;
      const safeUrl = sanitizeHref(rawSoc.url);
      if (safeUrl === '#') continue;
      if (nextSocials.some((s) => s.id === rawSoc.id || s.url === safeUrl)) continue;
      nextSocials.push({
        id: rawSoc.id,
        platform: String(rawSoc.platform ?? '').trim() || 'رابط',
        label: String(rawSoc.label ?? rawSoc.platform ?? '').trim() || 'رابط',
        handle: String(rawSoc.handle ?? '').trim() || safeUrl,
        url: safeUrl,
      });
      syncedCount += 1;
    }

    const tx = await this.client.transaction('write');
    try {
      await this.assertWritable(tx);
      for (const delPromoId of deletedPromoIds) {
        const delRes = await tx.execute({
          sql: `DELETE FROM promo_codes WHERE id = ?`,
          args: [delPromoId],
        });
        syncedCount += delRes.rowsAffected;
      }

      for (const rawPromo of incomingPromos) {
        if (!rawPromo || typeof rawPromo.id !== 'string' || deletedPromoIds.has(rawPromo.id)) {
          continue;
        }
        const normalizedCode =
          typeof rawPromo.code === 'string' ? normalizePromoCode(rawPromo.code) : '';
        const ownerName =
          typeof rawPromo.ownerName === 'string' ? rawPromo.ownerName.trim() : '';
        const discountType: PromoDiscountType =
          rawPromo.discountType === 'fixed' ? 'fixed' : 'percent';
        const discountValue = Math.round(Number(rawPromo.discountValue ?? 0));
        if (
          !normalizedCode ||
          ownerName.length < 2 ||
          !Number.isFinite(discountValue) ||
          discountValue <= 0
        ) {
          continue;
        }
        const existingPromo = await tx.execute({
          sql: `SELECT id FROM promo_codes WHERE id = ? OR UPPER(code) = ? LIMIT 1`,
          args: [rawPromo.id, normalizedCode],
        });
        if (existingPromo.rows.length > 0) continue;

        await tx.execute({
          sql: `INSERT INTO promo_codes (
                  id, code, owner_name, discount_type, discount_value,
                  duration_days, expires_at, active, times_used, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            rawPromo.id,
            normalizedCode,
            ownerName,
            discountType,
            discountValue,
            typeof rawPromo.durationDays === 'number' && Number.isFinite(rawPromo.durationDays)
              ? rawPromo.durationDays
              : null,
            typeof rawPromo.expiresAt === 'string' && rawPromo.expiresAt.trim()
              ? rawPromo.expiresAt.trim()
              : null,
            typeof rawPromo.active === 'boolean' ? (rawPromo.active ? 1 : 0) : 1,
            typeof rawPromo.timesUsed === 'number' ? rawPromo.timesUsed : 0,
            typeof rawPromo.createdAt === 'string' && rawPromo.createdAt
              ? rawPromo.createdAt
              : new Date().toISOString(),
          ],
        });
        syncedCount += 1;
      }

      await this.saveCatalogMirror(
        {
          storeInfo: mirror.storeInfo,
          products: nextProducts,
          socialLinks: nextSocials,
          deletedSeedIds: Array.from(deletedSeedSet),
        },
        tx
      );
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }

    const promoCodes = await this.listPromoCodes();
    return { syncedCount, products: nextProducts, promoCodes, socialLinks: nextSocials };
  }

  // Persistent Product Images (replaces ephemeral public/uploads)
  async saveProductImage(dataUrl: string): Promise<{
    id: string;
    ext: 'jpg' | 'png' | 'webp';
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    sha256: string;
    sizeBytes: number;
  }> {
    await this.ensureSchema();
    await this.assertWritable();

    const trimmed = dataUrl.trim();
    const match = trimmed.match(
      /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i
    );
    if (!match) {
      throw new StoreValidationError(
        400,
        'صيغة الصورة غير مدعومة. يرجى اختيار صورة JPG أو PNG أو WEBP.'
      );
    }

    const rawSubtype = match[1].toLowerCase();
    const ext: 'jpg' | 'png' | 'webp' =
      rawSubtype === 'jpeg' || rawSubtype === 'jpg'
        ? 'jpg'
        : rawSubtype === 'png'
          ? 'png'
          : 'webp';
    const mimeType: 'image/jpeg' | 'image/png' | 'image/webp' =
      ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'image/webp';

    const buf = Buffer.from(match[2], 'base64');
    if (buf.length === 0) {
      throw new StoreValidationError(400, 'ملف الصورة فارغ.');
    }
    if (buf.length > MAX_PRODUCT_IMAGE_BYTES) {
      throw new StoreValidationError(
        413,
        'حجم الصورة يتجاوز الحد الأقصى الآمن للتخزين الدائم (1.5 ميغابايت). يرجى ضغط الصورة قبل الرفع.'
      );
    }
    if (!hasValidImageMagicBytes(buf, ext)) {
      throw new StoreValidationError(400, 'تعذر التحقق من محتوى الصورة المرفوعة.');
    }

    const id = crypto.randomUUID();
    const sha256 = sha256Hex(buf);
    const nowIso = new Date().toISOString();

    await this.client.execute({
      sql: `INSERT INTO product_images (id, ext, mime_type, sha256, size_bytes, data_blob, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, ext, mimeType, sha256, buf.length, new Uint8Array(buf), nowIso],
    });

    return { id, ext, mimeType, sha256, sizeBytes: buf.length };
  }

  async getProductImage(rawIdWithOptExt: string): Promise<StoredProductImage | null> {
    await this.ensureSchema();
    const cleaned = rawIdWithOptExt.trim().replace(/\.(jpg|jpeg|png|webp)$/i, '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned)) {
      return null;
    }
    const res = await this.client.execute({
      sql: `SELECT id, ext, mime_type, sha256, size_bytes, data_blob, created_at
            FROM product_images WHERE id = ? LIMIT 1`,
      args: [cleaned],
    });
    const r = res.rows[0];
    if (!r) return null;

    const blobRaw = r.data_blob as unknown;
    let data: Uint8Array;
    if (blobRaw instanceof Uint8Array) {
      data = blobRaw;
    } else if (blobRaw instanceof ArrayBuffer) {
      data = new Uint8Array(blobRaw);
    } else if (ArrayBuffer.isView(blobRaw)) {
      data = new Uint8Array(blobRaw.buffer, blobRaw.byteOffset, blobRaw.byteLength);
    } else if (typeof blobRaw === 'string') {
      data = new Uint8Array(Buffer.from(blobRaw, 'base64'));
    } else {
      throw new Error('Stored product image payload has unexpected type.');
    }

    return {
      id: String(r.id),
      ext: (r.ext === 'png' || r.ext === 'webp' ? r.ext : 'jpg'),
      mimeType:
        r.mime_type === 'image/png' || r.mime_type === 'image/webp'
          ? r.mime_type
          : 'image/jpeg',
      sha256: String(r.sha256),
      sizeBytes: Number(r.size_bytes),
      data,
      createdAt: String(r.created_at),
    };
  }

  async exportOperationalState(): Promise<ExportedOperationalState> {
    await this.ensureSchema();
    const [
      orders,
      customRequests,
      notifications,
      promoCodes,
      loyaltyProfiles,
      orderSequence,
      writeFreeze,
      migrationAudit,
    ] = await Promise.all([
      this.listOrders(),
      this.listCustomRequests(),
      this.listNotifications(),
      this.listPromoCodes(),
      this.listLoyaltyProfiles(),
      this.getOrderSequence(),
      this.isWriteFrozen(),
      this.getMigrationAudit(),
    ]);

    const data = {
      orders,
      customRequests,
      notifications,
      promoCodes,
      loyaltyProfiles,
      orderSequence,
      writeFreeze,
      migrationAudit,
    };

    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      storageEngine: 'turso',
      data,
      integrity: {
        dataSectionSha256: sha256Hex(JSON.stringify(data)),
      },
    };
  }
}
