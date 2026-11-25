import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BLAUGRANA_DEFAULT_SIZE_PRICES,
  DEFAULT_STATUS_MESSAGES,
  buildOwnerOrderAlertMessage,
  calculateCartSummary,
  compareProductsByCode,
  isPromoCodeValidNow,
  isQualifyingPerfumeCategory,
  normalizePhoneNumber,
  normalizePromoCode,
  resolveProductUnitPrice,
  sanitizeHref,
  sanitizeImageInput,
  validateCheckoutInput,
  validateCustomRequestInput,
  type AdminNotification,
  type AppliedPromoPreview,
  type CustomPerfumeRequest,
  type CustomRequestStatus,
  type Order,
  type OrderItem,
  type OrderStatus,
  type Product,
  type ProductCategory,
  type PromoCode,
  type PromoDiscountType,
  type SocialLink,
} from './src/utils/commerce.ts';
import {
  getOrCreateLoyaltyProfile,
  loadDatabase,
  saveDatabase,
  type DatabaseState,
} from './src/server/store.ts';
import {
  TursoStore,
  WriteFreezeError,
  StoreValidationError,
  hasValidImageMagicBytes,
} from './src/server/tursoStore.ts';
import { FirestoreCatalogReader } from './src/server/firestoreCatalogReader.ts';

const PORT = Number(process.env.PORT) || 3000;

const VALID_CATEGORIES = new Set<ProductCategory>([
  'blaugrana',
  'other_brands',
  'body_mist',
  'room_spray',
  'deodorant',
  'hair_care',
  'tester',
]);

const VALID_ORDER_STATUSES = new Set<OrderStatus>([
  'تم الاستلام',
  'قيد المراجعة',
  'تم التجهيز',
  'قيد التوصيل',
  'تم التسليم',
]);

const VALID_REQUEST_STATUSES = new Set<CustomRequestStatus>([
  'قيد البحث',
  'تم التوفير',
  'تم التواصل',
]);

const DEFAULT_IMAGES: Record<ProductCategory, string> = {
  blaugrana: '/src/assets/images/perfume_signature_oud_1795208161900.jpg',
  other_brands: '/src/assets/images/perfume_crimson_rose_1795208162606.jpg',
  body_mist: '/src/assets/images/product_body_mist_1795208162237.jpg',
  room_spray: '/src/assets/images/product_body_mist_1795208162237.jpg',
  deodorant: '/src/assets/images/product_body_mist_1795208162237.jpg',
  hair_care: '/assets/aistudio/hair_shampoo_studio.jpg',
  tester: '/src/assets/images/product_tester_kit_1795208162880.jpg',
};

export interface CreateAppOptions {
  tursoStore?: TursoStore | null;
  catalogReader?: FirestoreCatalogReader | null;
  strictNoLocalWrites?: boolean;
  apiOnly?: boolean;
  allowedOrigins?: string[];
  publicApiBaseUrl?: string;
  adminPasscode?: string;
  sessionSecret?: string;
  rateLimitMaxAuth?: number;
  rateLimitMaxWrites?: number;
  rateLimitWindowMs?: number;
  telegramSender?: (creds: { botToken: string; chatId: string }, text: string) => Promise<{ sent: boolean; error?: string }>;
}

function getEnvAdminPasscode(override?: string): string {
  return (override ?? process.env.ADMIN_PASSCODE ?? '').trim();
}

function verifyPasscodeConstantTime(candidate: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function hashPasscodeScrypt(passcode: string, saltHex: string): string {
  return crypto.scryptSync(passcode, saltHex, 64).toString('hex');
}

function sanitizeImageUrl(url: unknown, fallbackCategory: ProductCategory): string {
  return sanitizeImageInput(url, DEFAULT_IMAGES[fallbackCategory]);
}

function buildCombinedNotes(
  rawNotes: string,
  topNotes?: string,
  heartNotes?: string,
  baseNotes?: string
): string {
  const structured = [topNotes, heartNotes, baseNotes]
    .map((s) => (s ?? '').trim())
    .filter(Boolean);
  if (structured.length > 0) {
    return structured.join(' · ');
  }
  return rawNotes.trim() || 'تركيبة فاخرة مختارة بعناية';
}

function createSlidingWindowLimiter(maxRequests: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (maxRequests <= 0) {
      next();
      return;
    }
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= maxRequests) {
      res.status(429).json({
        error: 'تم تجاوز الحد المسموح من المحاولات مؤقتاً. يرجى الانتظار قليلاً ثم المحاولة مجدداً.',
        code: 'RATE_LIMITED',
      });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) {
      for (const [k, arr] of hits.entries()) {
        if (arr.every((t) => t <= windowStart)) hits.delete(k);
      }
    }
    next();
  };
}

function reconcileDbSyncPayload(
  db: DatabaseState,
  payload: {
    addedProducts?: unknown;
    updatedProducts?: unknown;
    deletedIds?: unknown;
    promoCodes?: unknown;
    deletedPromoIds?: unknown;
    socialLinks?: unknown;
  }
): number {
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

  if (deletedIds.size > 0) {
    const beforeLen = db.products.length;
    db.products = db.products.filter((p) => !deletedIds.has(p.id));
    if (db.products.length !== beforeLen) {
      syncedCount += beforeLen - db.products.length;
    }
    const existingDeleted = new Set(db.deletedSeedIds ?? []);
    for (const id of deletedIds) {
      if (!existingDeleted.has(id)) {
        existingDeleted.add(id);
        syncedCount += 1;
      }
    }
    db.deletedSeedIds = Array.from(existingDeleted);
  }

  for (const raw of addedProducts) {
    if (!raw || typeof raw.id !== 'string' || deletedIds.has(raw.id)) continue;
    if (db.products.some((p) => p.id === raw.id)) continue;
    const category: ProductCategory = VALID_CATEGORIES.has(raw.category)
      ? raw.category
      : 'blaugrana';
    const priceIqd =
      typeof raw.priceIqd === 'number' && Number.isFinite(raw.priceIqd) && raw.priceIqd >= 500
        ? Math.round(raw.priceIqd)
        : 30000;
    const product: Product = {
      id: raw.id,
      code: typeof raw.code === 'string' && raw.code.trim() ? raw.code.trim() : 'M99',
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'عطر بلوكرانا',
      brand: typeof raw.brand === 'string' && raw.brand.trim() ? raw.brand.trim() : 'بلوكرانا',
      category,
      priceIqd,
      size: typeof raw.size === 'string' && raw.size.trim() ? raw.size.trim() : '100 مل',
      ...(raw.sizePrices ? { sizePrices: raw.sizePrices } : {}),
      notes: typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : 'تركيبة فاخرة',
      ...(raw.topNotes ? { topNotes: raw.topNotes } : {}),
      ...(raw.heartNotes ? { heartNotes: raw.heartNotes } : {}),
      ...(raw.baseNotes ? { baseNotes: raw.baseNotes } : {}),
      longevity: typeof raw.longevity === 'string' && raw.longevity.trim() ? raw.longevity.trim() : '24 ساعة',
      sillage: typeof raw.sillage === 'string' && raw.sillage.trim() ? raw.sillage.trim() : 'فوحان ممتاز',
      description:
        typeof raw.description === 'string' && raw.description.trim()
          ? raw.description.trim()
          : 'منتج أصلي من وكالة بلوكرانا بضمان الثبات والفوحان.',
      imageUrl: sanitizeImageUrl(raw.imageUrl, category),
      hasCustomImage: typeof raw.hasCustomImage === 'boolean' ? raw.hasCustomImage : true,
      includesFreeTester:
        typeof raw.includesFreeTester === 'boolean'
          ? raw.includesFreeTester
          : isQualifyingPerfumeCategory(category),
      inStock: typeof raw.inStock === 'boolean' ? raw.inStock : true,
    };
    db.products.unshift(product);
    syncedCount += 1;
  }

  for (const raw of updatedProducts) {
    if (!raw || typeof raw.id !== 'string' || deletedIds.has(raw.id)) continue;
    const idx = db.products.findIndex((p) => p.id === raw.id);
    if (idx === -1) continue;
    const existing = db.products[idx];
    const category: ProductCategory = VALID_CATEGORIES.has(raw.category)
      ? raw.category
      : existing.category;
    const nextImg = sanitizeImageUrl(raw.imageUrl, category);
    const merged: Product = {
      ...existing,
      ...raw,
      category,
      imageUrl: nextImg,
      hasCustomImage: typeof raw.hasCustomImage === 'boolean' ? raw.hasCustomImage : true,
    };
    if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      db.products[idx] = merged;
      syncedCount += 1;
    }
  }

  if (deletedPromoIds.size > 0) {
    const beforePromos = db.promoCodes.length;
    db.promoCodes = db.promoCodes.filter((p) => !deletedPromoIds.has(p.id));
    if (db.promoCodes.length !== beforePromos) {
      syncedCount += beforePromos - db.promoCodes.length;
    }
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
    if (!normalizedCode || ownerName.length < 2 || !Number.isFinite(discountValue) || discountValue <= 0) {
      continue;
    }
    const exists = db.promoCodes.some(
      (p) => p.id === rawPromo.id || normalizePromoCode(p.code) === normalizedCode
    );
    if (exists) continue;
    db.promoCodes.unshift({
      id: rawPromo.id,
      code: normalizedCode,
      ownerName,
      discountType,
      discountValue,
      durationDays:
        typeof rawPromo.durationDays === 'number' && Number.isFinite(rawPromo.durationDays)
          ? rawPromo.durationDays
          : null,
      expiresAt:
        typeof rawPromo.expiresAt === 'string' && rawPromo.expiresAt.trim()
          ? rawPromo.expiresAt.trim()
          : null,
      active: typeof rawPromo.active === 'boolean' ? rawPromo.active : true,
      timesUsed: typeof rawPromo.timesUsed === 'number' ? rawPromo.timesUsed : 0,
      createdAt:
        typeof rawPromo.createdAt === 'string' && rawPromo.createdAt
          ? rawPromo.createdAt
          : new Date().toISOString(),
    });
    syncedCount += 1;
  }

  for (const rawSoc of incomingSocials) {
    if (!rawSoc || typeof rawSoc.id !== 'string' || typeof rawSoc.url !== 'string') continue;
    const safeUrl = sanitizeHref(rawSoc.url);
    if (safeUrl === '#') continue;
    if (db.socialLinks.some((s) => s.id === rawSoc.id || s.url === safeUrl)) continue;
    db.socialLinks.push({
      id: rawSoc.id,
      platform: String(rawSoc.platform ?? '').trim() || 'رابط',
      label: String(rawSoc.label ?? rawSoc.platform ?? '').trim() || 'رابط',
      handle: String(rawSoc.handle ?? '').trim() || safeUrl,
      url: safeUrl,
    });
    syncedCount += 1;
  }

  db.products.sort(compareProductsByCode);
  return syncedCount;
}

export function createApp(options: CreateAppOptions = {}) {
  const tursoUrl = (process.env.TURSO_DATABASE_URL ?? '').trim();
  const tursoAuthToken = (process.env.TURSO_AUTH_TOKEN ?? '').trim();
  const turso: TursoStore | null =
    options.tursoStore !== undefined
      ? options.tursoStore
      : tursoUrl
        ? new TursoStore({ url: tursoUrl, authToken: tursoAuthToken || undefined })
        : null;

  const catalogReader =
    options.catalogReader !== undefined
      ? options.catalogReader
      : new FirestoreCatalogReader();

  const strictNoLocalWrites =
    options.strictNoLocalWrites ??
    (process.env.STRICT_NO_LOCAL_WRITES ?? '').trim().toLowerCase() === 'true';

  const apiOnly =
    options.apiOnly ??
    (process.env.API_ONLY ?? '').trim().toLowerCase() === 'true';

  const configuredOrigins = (
    options.allowedOrigins ??
    (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  ).map((o) => o.replace(/\/+$/, ''));

  const allowlistOrigins = new Set<string>([
    ...configuredOrigins,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));

  // Express 4 does not catch rejected promises automatically; wrap all route handlers safely.
  for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    const original = app[method].bind(app);
    (app as unknown as Record<string, (...a: unknown[]) => unknown>)[method] = (
      routePath: unknown,
      ...handlers: unknown[]
    ) => {
      if (typeof routePath !== 'string' || handlers.length === 0) {
        return original(routePath as string, ...(handlers as express.RequestHandler[]));
      }
      const wrapped = handlers.map((h) =>
        typeof h === 'function'
          ? (req: Request, res: Response, next: NextFunction) => {
              try {
                const out = (
                  h as (rq: Request, rs: Response, nx: NextFunction) => unknown
                )(req, res, next);
                if (out && typeof (out as Promise<unknown>).catch === 'function') {
                  (out as Promise<unknown>).catch(next);
                }
              } catch (err) {
                next(err);
              }
            }
          : h
      );
      return original(routePath, ...(wrapped as express.RequestHandler[]));
    };
  }

  // CORS Allowlist on /api/*
  app.use('/api', (req, res, next) => {
    const originHeader = req.headers.origin;
    if (!originHeader) {
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    const normalizedOrigin = originHeader.trim().replace(/\/+$/, '');
    const requestHost = req.get('host');
    const isSameHost =
      requestHost &&
      (normalizedOrigin === `https://${requestHost}` ||
        normalizedOrigin === `http://${requestHost}`);

    const enforceStrictAllowlist = configuredOrigins.length > 0;
    const isAllowed =
      isSameHost ||
      allowlistOrigins.has(normalizedOrigin) ||
      (!enforceStrictAllowlist && normalizedOrigin.startsWith('http://localhost:'));

    if (!isAllowed) {
      res.status(403).json({
        error: 'النطاق غير مصرح له بالوصول إلى واجهة البرمجة.',
        code: 'CORS_ORIGIN_FORBIDDEN',
      });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const authRateLimiter = createSlidingWindowLimiter(
    options.rateLimitMaxAuth ?? 20,
    options.rateLimitWindowMs ?? 15 * 60 * 1000
  );
  const publicWriteLimiter = createSlidingWindowLimiter(
    options.rateLimitMaxWrites ?? 45,
    options.rateLimitWindowMs ?? 5 * 60 * 1000
  );

  // Static /uploads serving ONLY in non-API-only dev/legacy fallback
  const UPLOADS_DIR = path.resolve(process.cwd(), 'public', 'uploads');
  if (!apiOnly && fs.existsSync(UPLOADS_DIR)) {
    app.use('/uploads', express.static(UPLOADS_DIR));
  }

  let localFallbackSecret: string | null = options.sessionSecret ?? null;

  async function resolveSessionSecret(): Promise<string> {
    if (options.sessionSecret && options.sessionSecret.length >= 16) {
      return options.sessionSecret;
    }
    const envSecret = (process.env.SESSION_SECRET ?? '').trim();
    if (envSecret.length >= 16) return envSecret;

    if (turso) {
      return turso.getOrCreateSessionSecret();
    }
    if (strictNoLocalWrites) {
      if (!localFallbackSecret) {
        localFallbackSecret = crypto.randomBytes(32).toString('hex');
      }
      return localFallbackSecret;
    }
    const db = loadDatabase();
    if (db.sessionSecret && db.sessionSecret.length >= 16) {
      return db.sessionSecret;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    db.sessionSecret = generated;
    saveDatabase(db);
    return generated;
  }

  async function getAdminAuthMode() {
    if (getEnvAdminPasscode(options.adminPasscode).length > 0) {
      return { configured: true, mode: 'env' as const };
    }
    if (turso) {
      const cred = await turso.getAdminCredential();
      return cred
        ? { configured: true, mode: 'claimed' as const }
        : { configured: false, mode: 'unclaimed' as const };
    }
    if (strictNoLocalWrites) {
      return { configured: false, mode: 'unclaimed' as const };
    }
    const db = loadDatabase();
    if (db.adminCredential) {
      return { configured: true, mode: 'claimed' as const };
    }
    return { configured: false, mode: 'unclaimed' as const };
  }

  async function signAdminToken(): Promise<string> {
    const secret = await resolveSessionSecret();
    const payload = {
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
      jti: crypto.randomUUID(),
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    return `${encoded}.${sig}`;
  }

  async function verifyAdminToken(token: string): Promise<boolean> {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [encoded, sig] = parts;
    if (!encoded || !sig) return false;

    const secret = await resolveSessionSecret();
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(encoded)
      .digest('base64url');

    const sigBuf = Buffer.from(sig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expectedBuf.length) return false;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

    try {
      const parsed = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8')
      ) as { role?: string; exp?: number };
      if (parsed.role !== 'admin') return false;
      if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return false;
      return true;
    } catch {
      return false;
    }
  }

  async function requireAdmin(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const authHeader = req.headers.authorization ?? '';
      if (!authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'يرجى تسجيل الدخول للإدارة أولاً.' });
        return;
      }
      const token = authHeader.slice(7).trim();
      const valid = await verifyAdminToken(token);
      if (!valid) {
        res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى إعادة الدخول.' });
        return;
      }
      next();
    } catch {
      res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى إعادة الدخول.' });
    }
  }

  async function ensureWritableRoute(res: Response): Promise<boolean> {
    if (!turso && strictNoLocalWrites) {
      res.status(503).json({
        error: 'الخادم المحلي في وضع القراءة فقط لمنع الكتابة المؤقتة، يرجى استخدام الخادم الرئيسي.',
        code: 'STRICT_NO_LOCAL_WRITES',
      });
      return false;
    }
    if (turso && (await turso.isWriteFrozen())) {
      res.status(503).json({
        error: 'المتجر في وضع الصيانة المؤقتة حالياً لتحديث البيانات، يرجى المحاولة بعد قليل.',
        code: 'MAINTENANCE_FREEZE',
      });
      return false;
    }
    if (!turso && (process.env.WRITE_FREEZE_DEFAULT ?? '').trim().toLowerCase() === 'true') {
      res.status(503).json({
        error: 'المتجر في وضع الصيانة المؤقتة حالياً لتحديث البيانات، يرجى المحاولة بعد قليل.',
        code: 'MAINTENANCE_FREEZE',
      });
      return false;
    }
    return true;
  }

  const adminStreamClients = new Set<Response>();
  function broadcastAdminEvent(eventName: string, payload: unknown): void {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of adminStreamClients) {
      try {
        client.write(frame);
      } catch {
        adminStreamClients.delete(client);
      }
    }
  }

  async function getEffectiveTelegramCredentials(): Promise<{
    botToken: string;
    chatId: string;
  } | null> {
    const envToken = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
    const envChat = (process.env.TELEGRAM_CHAT_ID ?? '').trim();
    if (envToken && envChat) {
      return { botToken: envToken, chatId: envChat };
    }
    if (turso) {
      const cfg = await turso.getTelegramConfig();
      return cfg ? { botToken: cfg.botToken, chatId: cfg.chatId } : null;
    }
    if (strictNoLocalWrites) return null;
    const db = loadDatabase();
    return db.telegramConfig
      ? { botToken: db.telegramConfig.botToken, chatId: db.telegramConfig.chatId }
      : null;
  }

  async function getTelegramPublicStatus() {
    const creds = await getEffectiveTelegramCredentials();
    if (!creds) {
      return { configured: false, chatIdMasked: '' };
    }
    const cid = creds.chatId;
    const masked =
      cid.length > 4 ? `${'*'.repeat(Math.max(2, cid.length - 4))}${cid.slice(-4)}` : '****';
    return { configured: true, chatIdMasked: masked };
  }

  async function sendTelegramOwnerAlert(
    text: string
  ): Promise<{ sent: boolean; error?: string }> {
    const creds = await getEffectiveTelegramCredentials();
    if (!creds) return { sent: false };
    if (options.telegramSender) {
      return options.telegramSender(creds, text);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: creds.chatId,
            text,
          }),
          signal: controller.signal,
        }
      );
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        console.error(`Telegram alert HTTP ${resp.status}:`, errBody);
        return { sent: false, error: `HTTP ${resp.status}` };
      }
      return { sent: true };
    } catch (err) {
      console.error('Telegram alert failed:', err);
      return { sent: false, error: 'Network error' };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function getCatalogForPricingAndBootstrap() {
    const fallbackLoader = async () => {
      if (turso) {
        const localSeed = strictNoLocalWrites ? undefined : loadDatabase();
        const mirror = await turso.getCatalogMirror(
          localSeed
            ? {
                storeInfo: localSeed.storeInfo,
                products: localSeed.products,
                socialLinks: localSeed.socialLinks,
              }
            : undefined
        );
        return {
          version: 'mirror',
          updatedAt: new Date().toISOString(),
          storeInfo: mirror.storeInfo,
          products: mirror.products,
          socialLinks: mirror.socialLinks,
        };
      }
      const db = loadDatabase();
      return {
        version: 'local',
        updatedAt: new Date().toISOString(),
        storeInfo: db.storeInfo,
        products: db.products,
        socialLinks: db.socialLinks,
      };
    };

    const resolved = await catalogReader?.getAuthoritativeCatalog({
      fallbackCatalog: fallbackLoader,
    });
    if (resolved) return resolved;
    const fb = await fallbackLoader();
    return { ...fb, source: 'fallback' as const };
  }

  // Health & Liveness Probe
  app.get('/api/health', async (_req, res) => {
    try {
      const dbConnected = turso ? await turso.ping() : true;
      const writeFreeze = turso
        ? await turso.isWriteFrozen()
        : (process.env.WRITE_FREEZE_DEFAULT ?? '').trim().toLowerCase() === 'true';

      res.status(dbConnected ? 200 : 503).json({
        ok: dbConnected,
        storageEngine: turso ? 'turso' : strictNoLocalWrites ? 'read-only-disabled' : 'local-json',
        dbConnected,
        writeFreeze,
        strictNoLocalWrites,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({
        ok: false,
        storageEngine: turso ? 'turso' : 'unknown',
        dbConnected: false,
        error: err instanceof Error ? err.message : 'Database unreachable',
      });
    }
  });

  // Persistent Image Serving (replaces ephemeral public/uploads when stored in Turso)
  app.get('/api/images/:id', async (req, res) => {
    if (!turso) {
      res.status(404).json({ error: 'الصورة غير متوفرة.' });
      return;
    }
    const img = await turso.getProductImage(String(req.params.id ?? ''));
    if (!img) {
      res.status(404).json({ error: 'الصورة غير موجودة.' });
      return;
    }
    const etag = `"${img.sha256}"`;
    res.setHeader('Content-Type', img.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.replace(/^W\//, '').trim() === etag) {
      res.status(304).end();
      return;
    }

    res.status(200).send(Buffer.from(img.data));
  });

  // Public Storefront Bootstrap
  app.get('/api/bootstrap', async (_req, res) => {
    const [catalog, adminAuthState] = await Promise.all([
      getCatalogForPricingAndBootstrap(),
      getAdminAuthMode(),
    ]);
    res.json({
      storeInfo: catalog.storeInfo,
      products: catalog.products,
      socialLinks: catalog.socialLinks,
      adminAuthState,
    });
  });

  // Loyalty Stamp Lookup by Phone
  app.get('/api/loyalty/:phone', async (req, res) => {
    const normalized = normalizePhoneNumber(String(req.params.phone ?? ''));
    if (normalized.length < 10) {
      res.status(400).json({ error: 'يرجى إدخال رقم هاتف صحيح.' });
      return;
    }
    if (turso) {
      const profile = await turso.getLoyaltyByPhone(normalized);
      res.json({ loyalty: profile });
      return;
    }
    if (strictNoLocalWrites) {
      res.status(503).json({
        error: 'الخدمة متوقفة على هذه النسخة، يرجى المحاولة عبر الخادم الرئيسي.',
        code: 'STRICT_NO_LOCAL_WRITES',
      });
      return;
    }
    const db = loadDatabase();
    const profile = getOrCreateLoyaltyProfile(db, normalized);
    res.json({ loyalty: profile });
  });

  // Public Customer Order Tracking (requires matching orderNumber + phone)
  app.get('/api/orders/track', async (req, res) => {
    const orderNumberRaw =
      typeof req.query.orderNumber === 'string'
        ? req.query.orderNumber.trim().toUpperCase()
        : '';
    const phoneRaw =
      typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
    const normalizedPhone = normalizePhoneNumber(phoneRaw);

    if (!orderNumberRaw || normalizedPhone.length < 10) {
      res.status(400).json({
        error: 'يرجى إدخال رقم الطلب (مثال: BG-1001) ورقم الهاتف المستخدم عند الطلب.',
      });
      return;
    }

    let found: Order | undefined | null;
    if (turso) {
      found = await turso.trackOrder(orderNumberRaw, normalizedPhone);
    } else if (strictNoLocalWrites) {
      res.status(503).json({ error: 'الخدمة غير متوفرة مؤقتاً.', code: 'STRICT_NO_LOCAL_WRITES' });
      return;
    } else {
      const db = loadDatabase();
      found = db.orders.find(
        (o) =>
          o.orderNumber.toUpperCase() === orderNumberRaw &&
          normalizePhoneNumber(o.phone) === normalizedPhone
      );
    }

    if (!found) {
      res.status(404).json({
        error: 'لم نعثر على طلب مطابق لرقم الطلب ورقم الهاتف المدخلين.',
      });
      return;
    }

    res.json({
      order: {
        id: found.id,
        orderNumber: found.orderNumber,
        createdAt: found.createdAt,
        deliveredAt: found.deliveredAt,
        fullName: found.fullName,
        exactLocation: found.exactLocation,
        phone: found.phone,
        items: found.items,
        pricing: found.pricing,
        voucherCode: found.voucherCode,
        status: found.status,
        estimatedArrival: found.estimatedArrival,
        statusMessage: found.statusMessage,
        statusHistory: found.statusHistory,
      },
    });
  });

  // Public Promo Code Validation
  app.post('/api/promo-codes/validate', publicWriteLimiter, async (req, res) => {
    const rawCode = typeof req.body?.code === 'string' ? req.body.code : '';
    const code = normalizePromoCode(rawCode);
    if (!code) {
      res.status(400).json({ error: 'يرجى إدخال كود الخصم أولاً.' });
      return;
    }

    let found: PromoCode | undefined | null;
    if (turso) {
      found = await turso.findPromoByCode(code);
    } else if (strictNoLocalWrites) {
      res.status(503).json({ error: 'الخدمة غير متوفرة مؤقتاً.', code: 'STRICT_NO_LOCAL_WRITES' });
      return;
    } else {
      const db = loadDatabase();
      found = db.promoCodes.find((p) => normalizePromoCode(p.code) === code);
    }

    if (!found) {
      res.status(404).json({
        error: 'كود الخصم غير موجود أو غير مفعّل حالياً.',
      });
      return;
    }
    const validity = isPromoCodeValidNow(found);
    if (validity.expired) {
      res.status(410).json({
        error: 'انتهت صلاحية كود الخصم هذا.',
      });
      return;
    }
    if (!found.active) {
      res.status(404).json({
        error: 'كود الخصم متوقف حالياً.',
      });
      return;
    }
    const promo: AppliedPromoPreview = {
      code: found.code,
      ownerName: found.ownerName,
      discountType: found.discountType,
      discountValue: found.discountValue,
      expiresAt: found.expiresAt ?? null,
    };
    res.json({ promo });
  });

  // Create Order (Checkout) — Uses live Firestore catalog pricing & ACID Turso transaction
  app.post('/api/orders', publicWriteLimiter, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const body = req.body as {
      fullName?: unknown;
      exactLocation?: unknown;
      birthDate?: unknown;
      phone?: unknown;
      promoCode?: unknown;
      items?: Array<{
        productId?: unknown;
        selectedSize?: unknown;
        quantity?: unknown;
      }>;
    };

    const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
    const exactLocation =
      typeof body.exactLocation === 'string' ? body.exactLocation.trim() : '';
    const birthDate =
      typeof body.birthDate === 'string' ? body.birthDate.trim() : '';
    const phoneRaw = typeof body.phone === 'string' ? body.phone.trim() : '';
    const rawPromoCode =
      typeof body.promoCode === 'string' ? normalizePromoCode(body.promoCode) : '';
    const rawItems = Array.isArray(body.items) ? body.items : [];

    const authoritativeCatalog = await getCatalogForPricingAndBootstrap();
    const resolvedCart: Array<{
      product: Product;
      selectedSize: string;
      unitPriceIqd: number;
      quantity: number;
    }> = [];

    for (const entry of rawItems) {
      const productId =
        typeof entry?.productId === 'string' ? entry.productId.trim() : '';
      const requestedSize =
        typeof entry?.selectedSize === 'string' ? entry.selectedSize.trim() : undefined;
      const quantity = Math.floor(Number(entry?.quantity ?? 0));
      if (!productId || !Number.isFinite(quantity) || quantity <= 0 || quantity > 50) {
        continue;
      }
      const found = authoritativeCatalog.products.find((p) => p.id === productId);
      if (found && found.inStock) {
        const resolved = resolveProductUnitPrice(found, requestedSize);
        resolvedCart.push({
          product: found,
          selectedSize: resolved.size,
          unitPriceIqd: resolved.priceIqd,
          quantity,
        });
      }
    }

    const validation = validateCheckoutInput({
      fullName,
      exactLocation,
      birthDate,
      phone: phoneRaw,
      itemsCount: resolvedCart.length,
    });

    if (!validation.valid) {
      res.status(400).json({ error: Object.values(validation.errors)[0], errors: validation.errors });
      return;
    }

    if (turso) {
      try {
        const created = await turso.createOrderAtomic({
          fullName,
          exactLocation,
          birthDate,
          phone: phoneRaw,
          promoCode: rawPromoCode || undefined,
          resolvedCart,
        });

        broadcastAdminEvent('new_order', {
          order: created.order,
          notification: created.notification,
        });
        await sendTelegramOwnerAlert(created.notification.message);

        res.status(201).json({
          order: created.order,
          loyalty: created.loyalty,
          thankYouMessage: `شكراً لك من القلب يا ${fullName} على ثقتك بوكالة بلوكرانا للعطور! تم استلام طلبك رقم ${created.order.orderNumber} بنجاح، وسيتم تجهيز عطرك مع تيستر التجربة المجاني وضمان الثبات والفوحان الذهبي.`,
        });
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof StoreValidationError) {
          res.status(err.statusCode).json({ error: err.message, errors: err.errors });
          return;
        }
        console.error('Order transaction error:', err);
        res.status(500).json({ error: 'تعذر حفظ الطلب في قاعدة البيانات، يرجى المحاولة مجدداً.' });
      }
      return;
    }

    // Local development fallback (strictly forbidden if strictNoLocalWrites is enabled)
    const db = loadDatabase();
    let matchedPromoRecord: PromoCode | undefined;
    let appliedPromo: AppliedPromoPreview | null = null;
    if (rawPromoCode) {
      matchedPromoRecord = db.promoCodes.find(
        (p) => normalizePromoCode(p.code) === rawPromoCode
      );
      if (!matchedPromoRecord) {
        res.status(400).json({ error: 'كود الخصم المدخل غير صحيح أو غير مفعّل.' });
        return;
      }
      const promoValidity = isPromoCodeValidNow(matchedPromoRecord);
      if (promoValidity.expired) {
        res.status(410).json({ error: 'انتهت صلاحية كود الخصم هذا.' });
        return;
      }
      if (!matchedPromoRecord.active) {
        res.status(400).json({ error: 'كود الخصم متوقف حالياً.' });
        return;
      }
      appliedPromo = {
        code: matchedPromoRecord.code,
        ownerName: matchedPromoRecord.ownerName,
        discountType: matchedPromoRecord.discountType,
        discountValue: matchedPromoRecord.discountValue,
        expiresAt: matchedPromoRecord.expiresAt ?? null,
      };
    }

    const normalizedPhone = normalizePhoneNumber(phoneRaw);
    const priorProfile = getOrCreateLoyaltyProfile(db, normalizedPhone);
    const pricing = calculateCartSummary(
      resolvedCart.map((c) => ({
        product: c.product,
        selectedSize: c.selectedSize,
        quantity: c.quantity,
      })),
      priorProfile.totalQualifyingPerfumes,
      appliedPromo
    );

    const orderNumber = `BG-${db.orderSequence}`;
    db.orderSequence += 1;

    const orderItems: OrderItem[] = resolvedCart.map(
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

    const voucherCode = priorProfile.voucherCode;
    const nowIso = new Date().toISOString();
    const newOrder: Order = {
      id: crypto.randomUUID(),
      orderNumber,
      createdAt: nowIso,
      fullName,
      exactLocation,
      birthDate,
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

    const newTotalPerfumes =
      priorProfile.totalQualifyingPerfumes + pricing.qualifyingPerfumeUnits;
    const updatedLoyalty = {
      phone: normalizedPhone,
      totalQualifyingPerfumes: newTotalPerfumes,
      stamps: newTotalPerfumes % 5,
      stampsRemainingForFree: 5 - (newTotalPerfumes % 5),
      freePerfumesRedeemed:
        priorProfile.freePerfumesRedeemed + pricing.freePerfumeUnitsEarned,
      voucherCode,
      ordersCount: priorProfile.ordersCount + 1,
    };

    if (matchedPromoRecord && pricing.promoDiscountIqd > 0) {
      matchedPromoRecord.timesUsed = (matchedPromoRecord.timesUsed ?? 0) + 1;
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
      customerName: fullName,
      customerPhone: normalizedPhone,
      exactLocation,
      totalIqd: pricing.totalIqd,
      itemsSummary,
      message: ownerAlertText,
      read: false,
    };

    db.loyaltyByPhone[normalizedPhone] = updatedLoyalty;
    db.orders.unshift(newOrder);
    db.notifications.unshift(notification);
    saveDatabase(db);

    broadcastAdminEvent('new_order', {
      order: newOrder,
      notification,
    });
    await sendTelegramOwnerAlert(ownerAlertText);

    res.status(201).json({
      order: newOrder,
      loyalty: updatedLoyalty,
      thankYouMessage: `شكراً لك من القلب يا ${fullName} على ثقتك بوكالة بلوكرانا للعطور! تم استلام طلبك رقم ${orderNumber} بنجاح، وسيتم تجهيز عطرك مع تيستر التجربة المجاني وضمان الثبات والفوحان الذهبي.`,
    });
  });

  // Create "وفرلي عطري" Custom Perfume Request
  app.post('/api/custom-requests', publicWriteLimiter, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const body = req.body as {
      perfumeName?: unknown;
      expectedPriceIqd?: unknown;
      size?: unknown;
      desiredDate?: unknown;
      customerName?: unknown;
      customerPhone?: unknown;
      notes?: unknown;
    };

    const perfumeName =
      typeof body.perfumeName === 'string' ? body.perfumeName.trim() : '';
    const expectedPriceIqd = Number(body.expectedPriceIqd ?? 0);
    const size = typeof body.size === 'string' ? body.size.trim() : '';
    const desiredDate =
      typeof body.desiredDate === 'string' ? body.desiredDate.trim() : '';
    const customerName =
      typeof body.customerName === 'string' ? body.customerName.trim() : '';
    const customerPhone =
      typeof body.customerPhone === 'string' ? body.customerPhone.trim() : '';
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';

    const validation = validateCustomRequestInput({
      perfumeName,
      expectedPriceIqd,
      size,
      desiredDate,
      customerName,
      customerPhone,
    });

    if (!validation.valid) {
      res.status(400).json({ error: Object.values(validation.errors)[0], errors: validation.errors });
      return;
    }

    if (turso) {
      try {
        const created = await turso.createCustomRequestAtomic({
          perfumeName,
          expectedPriceIqd,
          size,
          desiredDate,
          customerName,
          customerPhone,
          notes,
        });
        broadcastAdminEvent('custom_request', {
          request: created.request,
          notification: created.notification,
        });
        await sendTelegramOwnerAlert(created.notification.message);
        res.status(201).json({
          request: created.request,
          message: `تم تسجيل طلب "وفرلي عطري" بنجاح! سيعمل فريق بلوكرانا على توفير عطر "${perfumeName}" والتواصل معك قبل ${desiredDate}.`,
        });
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        res.status(500).json({ error: 'تعذر حفظ الطلب الخاص في قاعدة البيانات.' });
      }
      return;
    }

    const db = loadDatabase();
    const nowIso = new Date().toISOString();
    const normalizedPhone = normalizePhoneNumber(customerPhone);
    const created: CustomPerfumeRequest = {
      id: crypto.randomUUID(),
      createdAt: nowIso,
      perfumeName,
      expectedPriceIqd: Math.round(expectedPriceIqd),
      size,
      desiredDate,
      customerName,
      customerPhone: normalizedPhone,
      notes,
      status: 'قيد البحث',
    };

    const alertText = [
      `✨ طلب «وفرلي عطري» جديد`,
      `🧴 العطر: ${perfumeName} (${size})`,
      `👤 الزبون: ${customerName}`,
      `📱 الهاتف: ${normalizedPhone}`,
      `💰 السعر المتوقع: ${expectedPriceIqd.toLocaleString('en-US')} د.ع`,
      `📅 التاريخ المطلوب: ${desiredDate}`,
    ].join('\n');

    const notification: AdminNotification = {
      id: crypto.randomUUID(),
      createdAt: nowIso,
      type: 'custom_request',
      customerName,
      customerPhone: normalizedPhone,
      itemsSummary: `وفرلي عطري: ${perfumeName} (${size})`,
      message: alertText,
      read: false,
    };

    db.customRequests.unshift(created);
    db.notifications.unshift(notification);
    saveDatabase(db);

    broadcastAdminEvent('custom_request', {
      request: created,
      notification,
    });
    await sendTelegramOwnerAlert(alertText);

    res.status(201).json({
      request: created,
      message: `تم تسجيل طلب "وفرلي عطري" بنجاح! سيعمل فريق بلوكرانا على توفير عطر "${perfumeName}" والتواصل معك قبل ${desiredDate}.`,
    });
  });

  // Admin First-Run Claim
  app.post('/api/admin/claim', authRateLimiter, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const mode = await getAdminAuthMode();
    if (mode.configured) {
      res.status(409).json({
        error: 'رمز الإدارة مُعد مسبقاً. يرجى تسجيل الدخول مباشرة.',
      });
      return;
    }
    const passcode =
      typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    if (passcode.length < 4 || passcode.length > 64) {
      res.status(400).json({
        error: 'يجب أن يتكون رمز الإدارة من 4 أحرف أو أرقام على الأقل.',
      });
      return;
    }

    const saltHex = crypto.randomBytes(16).toString('hex');
    const hashHex = hashPasscodeScrypt(passcode, saltHex);
    const cred = {
      saltHex,
      hashHex,
      claimedAt: new Date().toISOString(),
    };

    if (turso) {
      try {
        const claimed = await turso.claimAdminCredential(cred);
        if (!claimed) {
          res.status(409).json({
            error: 'رمز الإدارة مُعد مسبقاً. يرجى تسجيل الدخول مباشرة.',
          });
          return;
        }
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    } else {
      const db = loadDatabase();
      db.adminCredential = cred;
      saveDatabase(db);
    }

    const token = await signAdminToken();
    res.status(201).json({
      token,
      adminAuthState: await getAdminAuthMode(),
    });
  });

  // Admin Login
  app.post('/api/admin/login', authRateLimiter, async (req, res) => {
    const passcode =
      typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    if (!passcode) {
      res.status(400).json({ error: 'يرجى إدخال رمز الإدارة.' });
      return;
    }

    const envPasscode = getEnvAdminPasscode(options.adminPasscode);
    if (envPasscode.length > 0) {
      if (!verifyPasscodeConstantTime(passcode, envPasscode)) {
        res.status(401).json({ error: 'رمز الإدارة غير صحيح.' });
        return;
      }
      res.json({ token: await signAdminToken(), adminAuthState: await getAdminAuthMode() });
      return;
    }

    const storedCred = turso
      ? await turso.getAdminCredential()
      : strictNoLocalWrites
        ? null
        : loadDatabase().adminCredential;

    if (!storedCred) {
      res.status(403).json({
        error: 'لم يتم تفعيل رمز الإدارة بعد. يرجى إعداده أولاً.',
      });
      return;
    }

    const candidateHashHex = hashPasscodeScrypt(passcode, storedCred.saltHex);
    const a = Buffer.from(candidateHashHex, 'hex');
    const b = Buffer.from(storedCred.hashHex, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'رمز الإدارة غير صحيح.' });
      return;
    }

    res.json({ token: await signAdminToken(), adminAuthState: await getAdminAuthMode() });
  });

  // Admin Dashboard Data
  app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
    if (turso) {
      const [
        orders,
        customRequests,
        notifications,
        promoCodes,
        loyaltyCount,
        telegramStatus,
        catalog,
      ] = await Promise.all([
        turso.listOrders(),
        turso.listCustomRequests(),
        turso.listNotifications(),
        turso.listPromoCodes(),
        turso.getLoyaltyCount(),
        getTelegramPublicStatus(),
        getCatalogForPricingAndBootstrap(),
      ]);

      res.json({
        orders,
        customRequests,
        notifications,
        products: catalog.products,
        socialLinks: catalog.socialLinks,
        promoCodes,
        loyaltyCount,
        telegramStatus,
      });
      return;
    }

    if (strictNoLocalWrites) {
      res.status(503).json({ error: 'الخادم المحلي في وضع القراءة فقط.', code: 'STRICT_NO_LOCAL_WRITES' });
      return;
    }

    const db = loadDatabase();
    res.json({
      orders: db.orders,
      customRequests: db.customRequests,
      notifications: db.notifications,
      products: db.products,
      socialLinks: db.socialLinks,
      promoCodes: db.promoCodes,
      loyaltyCount: Object.keys(db.loyaltyByPhone).length,
      telegramStatus: await getTelegramPublicStatus(),
    });
  });

  // Admin Maintenance Freeze Toggle
  app.post('/api/admin/maintenance-freeze', requireAdmin, async (req, res) => {
    if (!turso) {
      res.status(400).json({ error: 'ميزة تجميد الصيانة الدائم متاحة مع قاعدة Turso فقط.' });
      return;
    }
    const frozen = Boolean(req.body?.frozen);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const state = await turso.setWriteFreeze(frozen, reason);
    res.json({ ok: true, writeFreeze: state });
  });

  // Admin Authoritative Export State (with SHA-256 & documented migration gaps)
  app.get('/api/admin/export-state', requireAdmin, async (_req, res) => {
    if (turso) {
      const exported = await turso.exportOperationalState();
      res.json(exported);
      return;
    }
    res.status(400).json({ error: 'تصدير الحالة الموحد يتطلب تفعيل قاعدة Turso.' });
  });

  // Admin Real-Time Notification Stream (SSE over Bearer auth)
  app.get('/api/admin/notifications/stream', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    adminStreamClients.add(res);
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
        adminStreamClients.delete(res);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      adminStreamClients.delete(res);
    });
  });

  // Mark Admin Notifications Read
  app.patch('/api/admin/notifications/read-all', requireAdmin, async (_req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    if (turso) {
      try {
        const notifications = await turso.markAllNotificationsRead();
        res.json({ ok: true, notifications });
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
      return;
    }

    const db = loadDatabase();
    db.notifications = db.notifications.map((n) => ({ ...n, read: true }));
    saveDatabase(db);
    res.json({ ok: true, notifications: db.notifications });
  });

  // Configure Owner Telegram Instant Alert Bot
  app.put('/api/admin/telegram-config', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const botToken =
      typeof req.body?.botToken === 'string' ? req.body.botToken.trim() : '';
    const chatId =
      typeof req.body?.chatId === 'string' ? req.body.chatId.trim() : '';

    if (
      !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(botToken) ||
      !/^(-?\d{5,}|@[A-Za-z0-9_]{4,})$/.test(chatId)
    ) {
      res.status(400).json({
        error:
          'يرجى إدخال Bot Token صحيح (من @BotFather) و Chat ID صحيح لإرسال الإشعارات.',
      });
      return;
    }

    const nextConfig = {
      botToken,
      chatId,
      updatedAt: new Date().toISOString(),
    };

    if (turso) {
      try {
        await turso.setTelegramConfig(nextConfig);
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    } else {
      const db = loadDatabase();
      db.telegramConfig = nextConfig;
      saveDatabase(db);
    }

    res.json({ telegramStatus: await getTelegramPublicStatus() });
  });

  app.delete('/api/admin/telegram-config', requireAdmin, async (_req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    if (turso) {
      try {
        await turso.setTelegramConfig(null);
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    } else {
      const db = loadDatabase();
      db.telegramConfig = null;
      saveDatabase(db);
    }
    res.json({ telegramStatus: await getTelegramPublicStatus() });
  });

  app.post('/api/admin/telegram-test', requireAdmin, async (_req, res) => {
    const result = await sendTelegramOwnerAlert(
      '🔔 رسالة اختبار من لوحة تحكم وكالة بلوكرانا للعطور — الإشعارات الفورية مفعلة وتعمل بنجاح!'
    );
    if (!result.sent) {
      res.status(400).json({
        error: result.error
          ? `تعذر إرسال رسالة الاختبار (${result.error}). تأكد من تفعيل البوت وإرسال /start له أولاً.`
          : 'لم يتم ربط بوت تيليغرام بعد.',
      });
      return;
    }
    res.json({ ok: true });
  });

  // Admin Update Order Status
  app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const body = req.body as {
      status?: unknown;
      estimatedArrival?: unknown;
      statusMessage?: unknown;
    };
    const status = body.status as OrderStatus;
    if (!VALID_ORDER_STATUSES.has(status)) {
      res.status(400).json({ error: 'حالة الطلب غير صالحة.' });
      return;
    }

    if (turso) {
      try {
        const updated = await turso.updateOrderStatus(String(req.params.id ?? ''), {
          status,
          estimatedArrival:
            typeof body.estimatedArrival === 'string' ? body.estimatedArrival : undefined,
          statusMessage:
            typeof body.statusMessage === 'string' ? body.statusMessage : undefined,
        });
        if (!updated) {
          res.status(404).json({ error: 'الطلب غير موجود.' });
          return;
        }
        res.json({ order: updated });
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
      return;
    }

    const db = loadDatabase();
    const order = db.orders.find((o) => o.id === req.params.id);
    if (!order) {
      res.status(404).json({ error: 'الطلب غير موجود.' });
      return;
    }

    const nowIso = new Date().toISOString();
    const prevStatus = order.status;
    order.status = status;

    if (typeof body.estimatedArrival === 'string' && body.estimatedArrival.trim()) {
      order.estimatedArrival = body.estimatedArrival.trim();
    }
    if (typeof body.statusMessage === 'string' && body.statusMessage.trim()) {
      order.statusMessage = body.statusMessage.trim();
    } else if (prevStatus !== status) {
      order.statusMessage = DEFAULT_STATUS_MESSAGES[status];
    }

    if (status === 'تم التسليم' && !order.deliveredAt) {
      order.deliveredAt = nowIso;
    }

    if (!Array.isArray(order.statusHistory)) {
      order.statusHistory = [{ status: prevStatus, timestamp: order.createdAt }];
    }
    if (
      prevStatus !== status ||
      (typeof body.statusMessage === 'string' && body.statusMessage.trim())
    ) {
      order.statusHistory.push({
        status,
        timestamp: nowIso,
        note: order.statusMessage,
      });
    }

    saveDatabase(db);
    res.json({ order });
  });

  // Admin Update Custom Request Status
  app.patch('/api/admin/custom-requests/:id', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const status = req.body?.status as CustomRequestStatus;
    if (!VALID_REQUEST_STATUSES.has(status)) {
      res.status(400).json({ error: 'حالة الطلب الخاص غير صالحة.' });
      return;
    }

    if (turso) {
      try {
        const updated = await turso.updateCustomRequestStatus(String(req.params.id ?? ''), status);
        if (!updated) {
          res.status(404).json({ error: 'الطلب الخاص غير موجود.' });
          return;
        }
        res.json({ request: updated });
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
      return;
    }

    const db = loadDatabase();
    const customReq = db.customRequests.find((r) => r.id === req.params.id);
    if (!customReq) {
      res.status(404).json({ error: 'الطلب الخاص غير موجود.' });
      return;
    }
    customReq.status = status;
    saveDatabase(db);
    res.json({ request: customReq });
  });

  // Admin Upload Product Image (Persistent Turso BLOB up to 1.5MB; never ephemeral disk when Turso active)
  app.post('/api/admin/upload-image', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const dataUrl =
      typeof req.body?.dataUrl === 'string' ? req.body.dataUrl.trim() : '';

    if (turso) {
      try {
        const saved = await turso.saveProductImage(dataUrl);
        const publicBase = (
          options.publicApiBaseUrl ??
          process.env.PUBLIC_API_BASE_URL ??
          `${req.protocol}://${req.get('host') || 'localhost:3000'}`
        )
          .trim()
          .replace(/\/+$/, '');
        const imageUrl = `${publicBase}/api/images/${saved.id}.${saved.ext}`;
        res.status(201).json({
          imageUrl,
          id: saved.id,
          sha256: saved.sha256,
          sizeBytes: saved.sizeBytes,
        });
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof StoreValidationError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        res.status(500).json({ error: 'تعذر حفظ الصورة في قاعدة البيانات.' });
      }
      return;
    }

    // Local development fallback only
    const match = dataUrl.match(
      /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i
    );
    if (!match) {
      res.status(400).json({
        error: 'صيغة الصورة غير مدعومة. يرجى اختيار صورة JPG أو PNG أو WEBP.',
      });
      return;
    }

    const rawSubtype = match[1].toLowerCase();
    const ext = rawSubtype === 'jpeg' || rawSubtype === 'jpg' ? 'jpg' : rawSubtype;
    const buf = Buffer.from(match[2], 'base64');

    if (buf.length === 0 || buf.length > 5 * 1024 * 1024) {
      res.status(400).json({
        error: 'حجم الصورة يجب أن يكون أقل من 5 ميغابايت.',
      });
      return;
    }

    if (!hasValidImageMagicBytes(buf, ext)) {
      res.status(400).json({
        error: 'تعذر التحقق من محتوى الصورة المرفوعة.',
      });
      return;
    }

    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
    const filename = `${crypto.randomUUID()}.${ext}`;
    const targetPath = path.resolve(UPLOADS_DIR, filename);
    if (!targetPath.startsWith(UPLOADS_DIR + path.sep)) {
      res.status(400).json({ error: 'مسار غير صالح لحفظ الصورة.' });
      return;
    }

    fs.writeFileSync(targetPath, buf);
    res.status(201).json({ imageUrl: `/uploads/${filename}` });
  });

  // Helper to read & write catalog mirror cleanly across Turso / local dev
  async function getMirrorState() {
    if (turso) {
      const seed = strictNoLocalWrites ? undefined : loadDatabase();
      return turso.getCatalogMirror(
        seed
          ? {
              storeInfo: seed.storeInfo,
              products: seed.products,
              socialLinks: seed.socialLinks,
            }
          : undefined
      );
    }
    const db = loadDatabase();
    return {
      storeInfo: db.storeInfo,
      products: db.products,
      socialLinks: db.socialLinks,
      deletedSeedIds: db.deletedSeedIds ?? [],
    };
  }

  async function saveMirrorProducts(products: Product[], deletedSeedIds?: string[]) {
    if (turso) {
      await turso.saveCatalogMirror({
        products,
        ...(deletedSeedIds ? { deletedSeedIds } : {}),
      });
      catalogReader?.invalidateCache();
      return;
    }
    const db = loadDatabase();
    db.products = products;
    if (deletedSeedIds) db.deletedSeedIds = deletedSeedIds;
    saveDatabase(db);
    catalogReader?.invalidateCache();
  }

  // Admin Bulk Update Product Prices
  app.patch('/api/admin/products/bulk-prices', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const body = req.body as {
      mode?: unknown;
      price30?: unknown;
      price50?: unknown;
      price100?: unknown;
      category?: unknown;
      adjustType?: unknown;
      value?: unknown;
    };

    const mirror = await getMirrorState();
    let updatedCount = 0;

    if (body.mode === 'blaugrana_sizes') {
      const p30 = Math.round(Number(body.price30 ?? 0));
      const p50 = Math.round(Number(body.price50 ?? 0));
      const p100 = Math.round(Number(body.price100 ?? 0));
      if (
        !Number.isFinite(p30) ||
        p30 < 500 ||
        !Number.isFinite(p50) ||
        p50 < 500 ||
        !Number.isFinite(p100) ||
        p100 < 500
      ) {
        res.status(400).json({
          error: 'يرجى إدخال أسعار صحيحة (500 د.ع فأكثر) لأحجام 30 مل و50 مل و100 مل.',
        });
        return;
      }

      const nextProducts = mirror.products.map((product) => {
        if (product.category !== 'blaugrana') return product;
        updatedCount += 1;
        return {
          ...product,
          size: '100 مل',
          priceIqd: p100,
          sizePrices: {
            '30 مل': p30,
            '50 مل': p50,
            '100 مل': p100,
          },
        };
      });
      await saveMirrorProducts(nextProducts);
      res.json({ updatedCount, products: nextProducts });
      return;
    }

    if (body.mode === 'category_adjust') {
      const categoryRaw = typeof body.category === 'string' ? body.category : 'all';
      const adjustType = body.adjustType as 'percent' | 'fixed_price' | 'fixed_delta';
      const value = Number(body.value ?? 0);
      if (!Number.isFinite(value)) {
        res.status(400).json({ error: 'قيمة التعديل غير صالحة.' });
        return;
      }
      if (adjustType === 'fixed_price' && value < 500) {
        res.status(400).json({ error: 'السعر الموحد يجب أن لا يقل عن 500 د.ع.' });
        return;
      }
      if (adjustType === 'percent' && (value <= -95 || value > 500)) {
        res.status(400).json({ error: 'النسبة المئوية يجب أن تكون بين -95% و 500%.' });
        return;
      }

      const applyAdjustment = (oldPrice: number): number => {
        if (adjustType === 'fixed_price') return Math.max(500, Math.round(value));
        if (adjustType === 'percent') return Math.max(500, Math.round((oldPrice * (100 + value)) / 100));
        return Math.max(500, Math.round(oldPrice + value));
      };

      const nextProducts = mirror.products.map((product) => {
        if (categoryRaw !== 'all' && product.category !== categoryRaw) return product;
        updatedCount += 1;
        const nextPrice = applyAdjustment(product.priceIqd);
        let nextSizePrices = product.sizePrices;
        if (product.sizePrices) {
          const updatedSizes: Record<string, number> = {};
          for (const [sz, oldSzPrice] of Object.entries(product.sizePrices)) {
            updatedSizes[sz] = applyAdjustment(oldSzPrice);
          }
          nextSizePrices = updatedSizes;
        }
        return {
          ...product,
          priceIqd:
            nextSizePrices && typeof nextSizePrices['100 مل'] === 'number'
              ? nextSizePrices['100 مل']
              : nextPrice,
          ...(nextSizePrices ? { sizePrices: nextSizePrices } : {}),
        };
      });

      await saveMirrorProducts(nextProducts);
      res.json({ updatedCount, products: nextProducts });
      return;
    }

    res.status(400).json({ error: 'نوع تعديل الأسعار غير مدعوم.' });
  });

  // Admin Add Product (Single or Bulk)
  app.post('/api/admin/products', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const itemsInput = Array.isArray(req.body?.items)
      ? req.body.items
      : [req.body];

    const mirror = await getMirrorState();
    const createdProducts: Product[] = [];

    for (const item of itemsInput) {
      const code = typeof item?.code === 'string' ? item.code.trim() : '';
      const name = typeof item?.name === 'string' ? item.name.trim() : '';
      const brand =
        typeof item?.brand === 'string' && item.brand.trim()
          ? item.brand.trim()
          : 'بلوكرانا';
      const categoryRaw = item?.category as ProductCategory;
      const category: ProductCategory = VALID_CATEGORIES.has(categoryRaw)
        ? categoryRaw
        : 'blaugrana';
      let priceIqd = Math.round(Number(item?.priceIqd ?? 0));
      const size =
        typeof item?.size === 'string' && item.size.trim()
          ? item.size.trim()
          : '100 مل';

      let sizePrices: Record<string, number> | undefined;
      if (item?.sizePrices && typeof item.sizePrices === 'object') {
        const cleaned: Record<string, number> = {};
        for (const [sz, pr] of Object.entries(
          item.sizePrices as Record<string, unknown>
        )) {
          const num = Math.round(Number(pr));
          if (sz.trim() && Number.isFinite(num) && num >= 500) {
            cleaned[sz.trim()] = num;
          }
        }
        if (Object.keys(cleaned).length > 0) {
          sizePrices = cleaned;
          if (typeof cleaned['100 مل'] === 'number') {
            priceIqd = cleaned['100 مل'];
          }
        }
      } else if (category === 'blaugrana') {
        sizePrices = {
          ...BLAUGRANA_DEFAULT_SIZE_PRICES,
          ...(priceIqd >= 500 ? { '100 مل': priceIqd } : {}),
        };
        if (priceIqd <= 0) {
          priceIqd = BLAUGRANA_DEFAULT_SIZE_PRICES['100 مل'];
        }
      }

      const topNotes =
        typeof item?.topNotes === 'string' && item.topNotes.trim()
          ? item.topNotes.trim()
          : undefined;
      const heartNotes =
        typeof item?.heartNotes === 'string' && item.heartNotes.trim()
          ? item.heartNotes.trim()
          : undefined;
      const baseNotes =
        typeof item?.baseNotes === 'string' && item.baseNotes.trim()
          ? item.baseNotes.trim()
          : undefined;
      const rawNotes = typeof item?.notes === 'string' ? item.notes.trim() : '';
      const notes = rawNotes
        ? rawNotes
        : buildCombinedNotes('', topNotes, heartNotes, baseNotes);
      const longevity =
        typeof item?.longevity === 'string' && item.longevity.trim()
          ? item.longevity.trim()
          : '24 ساعة';
      const sillage =
        typeof item?.sillage === 'string' && item.sillage.trim()
          ? item.sillage.trim()
          : 'فوحان ممتاز';
      const description =
        typeof item?.description === 'string' && item.description.trim()
          ? item.description.trim()
          : 'منتج أصلي من وكالة بلوكرانا بضمان الثبات والفوحان.';
      const includesFreeTester =
        typeof item?.includesFreeTester === 'boolean'
          ? item.includesFreeTester
          : isQualifyingPerfumeCategory(category);
      const inStock =
        typeof item?.inStock === 'boolean' ? item.inStock : true;

      if (!code || !name || !Number.isFinite(priceIqd) || priceIqd <= 0) {
        res.status(400).json({
          error: 'يرجى التأكد من إدخال رقم العطر، اسم العطر، والسعر بشكل صحيح.',
        });
        return;
      }

      const sanitizedImg = sanitizeImageUrl(item?.imageUrl, category);
      const hasCustomImage =
        typeof item?.hasCustomImage === 'boolean'
          ? item.hasCustomImage
          : sanitizedImg !== DEFAULT_IMAGES.blaugrana;

      const product: Product = {
        id: `${category.slice(0, 2)}-${crypto.randomUUID().slice(0, 8)}`,
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
        imageUrl: sanitizedImg,
        hasCustomImage,
        includesFreeTester,
        inStock,
      };
      createdProducts.push(product);
    }

    const nextProducts = [...createdProducts, ...mirror.products].sort(compareProductsByCode);
    await saveMirrorProducts(nextProducts);
    res.status(201).json({ products: createdProducts });
  });

  // Admin Bulk Update Multiple Products
  app.put('/api/admin/products/bulk-update', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (updates.length === 0) {
      res.status(400).json({ error: 'لا توجد تعديلات لإرسالها.' });
      return;
    }

    const mirror = await getMirrorState();
    const nextProducts = mirror.products.map((p) => ({ ...p }));
    let updatedCount = 0;

    for (const patch of updates as Array<Partial<Product> & { id?: unknown }>) {
      if (typeof patch?.id !== 'string' || !patch.id) continue;
      const product = nextProducts.find((p) => p.id === patch.id);
      if (!product) continue;

      let changed = false;
      if (typeof patch.imageUrl === 'string') {
        product.imageUrl = sanitizeImageUrl(patch.imageUrl, product.category);
        product.hasCustomImage =
          typeof patch.hasCustomImage === 'boolean' ? patch.hasCustomImage : true;
        changed = true;
      }
      if (
        typeof patch.priceIqd === 'number' &&
        Number.isFinite(patch.priceIqd) &&
        patch.priceIqd >= 500
      ) {
        product.priceIqd = Math.round(patch.priceIqd);
        changed = true;
      }
      if (patch.sizePrices && typeof patch.sizePrices === 'object') {
        const cleaned: Record<string, number> = {};
        for (const [sz, pr] of Object.entries(patch.sizePrices)) {
          const num = Math.round(Number(pr));
          if (sz.trim() && Number.isFinite(num) && num >= 500) {
            cleaned[sz.trim()] = num;
          }
        }
        if (Object.keys(cleaned).length > 0) {
          product.sizePrices = cleaned;
          if (typeof cleaned['100 مل'] === 'number') {
            product.priceIqd = cleaned['100 مل'];
          }
          changed = true;
        }
      }
      if (typeof patch.inStock === 'boolean') {
        product.inStock = patch.inStock;
        changed = true;
      }
      if (typeof patch.name === 'string' && patch.name.trim()) {
        product.name = patch.name.trim();
        changed = true;
      }
      if (typeof patch.code === 'string' && patch.code.trim()) {
        product.code = patch.code.trim();
        changed = true;
      }
      if (typeof patch.notes === 'string' && patch.notes.trim()) {
        product.notes = patch.notes.trim();
        changed = true;
      }

      if (changed) updatedCount += 1;
    }

    nextProducts.sort(compareProductsByCode);
    await saveMirrorProducts(nextProducts);
    res.json({ updatedCount, products: nextProducts });
  });

  // Admin Sync Catalog (Reconciles PromoCodes to Turso + Catalog Mirror)
  app.post('/api/admin/sync-catalog', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    if (turso) {
      try {
        const seed = strictNoLocalWrites ? undefined : loadDatabase();
        const result = await turso.reconcileSyncPayloadToTurso(
          req.body ?? {},
          seed
            ? {
                storeInfo: seed.storeInfo,
                products: seed.products,
                socialLinks: seed.socialLinks,
              }
            : undefined
        );
        catalogReader?.invalidateCache();
        res.json(result);
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
      return;
    }

    const db = loadDatabase();
    const syncedCount = reconcileDbSyncPayload(db, req.body ?? {});
    if (syncedCount > 0) {
      saveDatabase(db);
    }
    res.json({
      syncedCount,
      products: db.products,
      promoCodes: db.promoCodes,
      socialLinks: db.socialLinks,
    });
  });

  // Admin Global Save All Site Changes
  app.post('/api/admin/save-all', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    if (turso) {
      try {
        const seed = strictNoLocalWrites ? undefined : loadDatabase();
        const result = await turso.reconcileSyncPayloadToTurso(
          req.body ?? {},
          seed
            ? {
                storeInfo: seed.storeInfo,
                products: seed.products,
                socialLinks: seed.socialLinks,
              }
            : undefined
        );
        catalogReader?.invalidateCache();
        res.json({
          ok: true,
          ...result,
          telegramStatus: await getTelegramPublicStatus(),
        });
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
      return;
    }

    const db = loadDatabase();
    const syncedCount = reconcileDbSyncPayload(db, req.body ?? {});
    saveDatabase(db);
    res.json({
      ok: true,
      syncedCount,
      products: db.products,
      promoCodes: db.promoCodes,
      socialLinks: db.socialLinks,
      telegramStatus: await getTelegramPublicStatus(),
    });
  });

  // Admin Update Product
  app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const mirror = await getMirrorState();
    const nextProducts = mirror.products.map((p) => ({ ...p }));
    const product = nextProducts.find((p) => p.id === req.params.id);
    if (!product) {
      res.status(404).json({ error: 'المنتج غير موجود.' });
      return;
    }

    const body = req.body as Partial<Product>;
    if (typeof body.code === 'string' && body.code.trim()) product.code = body.code.trim();
    if (typeof body.name === 'string' && body.name.trim()) product.name = body.name.trim();
    if (typeof body.brand === 'string' && body.brand.trim()) product.brand = body.brand.trim();
    if (body.category && VALID_CATEGORIES.has(body.category)) product.category = body.category;
    if (typeof body.priceIqd === 'number' && Number.isFinite(body.priceIqd) && body.priceIqd >= 500) {
      product.priceIqd = Math.round(body.priceIqd);
    }
    if (body.sizePrices && typeof body.sizePrices === 'object') {
      const cleaned: Record<string, number> = {};
      for (const [sz, pr] of Object.entries(body.sizePrices)) {
        const num = Math.round(Number(pr));
        if (sz.trim() && Number.isFinite(num) && num >= 500) cleaned[sz.trim()] = num;
      }
      if (Object.keys(cleaned).length > 0) {
        product.sizePrices = cleaned;
        if (typeof cleaned['100 مل'] === 'number') product.priceIqd = cleaned['100 مل'];
      }
    }
    if (typeof body.size === 'string' && body.size.trim()) product.size = body.size.trim();
    if (typeof body.topNotes === 'string') product.topNotes = body.topNotes.trim() || undefined;
    if (typeof body.heartNotes === 'string') product.heartNotes = body.heartNotes.trim() || undefined;
    if (typeof body.baseNotes === 'string') product.baseNotes = body.baseNotes.trim() || undefined;
    if (typeof body.notes === 'string' && body.notes.trim()) {
      product.notes = body.notes.trim();
    } else if (
      typeof body.topNotes === 'string' ||
      typeof body.heartNotes === 'string' ||
      typeof body.baseNotes === 'string'
    ) {
      product.notes = buildCombinedNotes(
        product.notes,
        product.topNotes,
        product.heartNotes,
        product.baseNotes
      );
    }
    if (typeof body.longevity === 'string') product.longevity = body.longevity.trim();
    if (typeof body.sillage === 'string') product.sillage = body.sillage.trim();
    if (typeof body.description === 'string') product.description = body.description.trim();
    if (typeof body.imageUrl === 'string') {
      product.imageUrl = sanitizeImageUrl(body.imageUrl, product.category);
      product.hasCustomImage =
        typeof body.hasCustomImage === 'boolean'
          ? body.hasCustomImage
          : product.imageUrl !== DEFAULT_IMAGES.blaugrana;
    } else if (typeof body.hasCustomImage === 'boolean') {
      product.hasCustomImage = body.hasCustomImage;
    }
    if (typeof body.includesFreeTester === 'boolean') product.includesFreeTester = body.includesFreeTester;
    if (typeof body.inStock === 'boolean') product.inStock = body.inStock;

    nextProducts.sort(compareProductsByCode);
    await saveMirrorProducts(nextProducts);
    res.json({ product });
  });

  // Admin Delete Product
  app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const mirror = await getMirrorState();
    const targetId = String(req.params.id ?? '');
    const filtered = mirror.products.filter((p) => p.id !== targetId);
    if (filtered.length === mirror.products.length) {
      res.status(404).json({ error: 'المنتج غير موجود.' });
      return;
    }
    const deletedSet = new Set(mirror.deletedSeedIds);
    deletedSet.add(targetId);
    await saveMirrorProducts(filtered, Array.from(deletedSet));
    res.json({ ok: true });
  });

  // Admin Promo Codes CRUD
  app.post('/api/admin/promo-codes', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const code =
      typeof req.body?.code === 'string' ? normalizePromoCode(req.body.code) : '';
    const ownerName =
      typeof req.body?.ownerName === 'string' ? req.body.ownerName.trim() : '';
    const discountType: PromoDiscountType =
      req.body?.discountType === 'fixed' ? 'fixed' : 'percent';
    const discountValue = Math.round(Number(req.body?.discountValue ?? 0));

    if (code.length < 2 || code.length > 24) {
      res.status(400).json({
        error: 'يجب أن يتكون كود البروموكود من 2 إلى 24 حرفاً أو رقماً.',
      });
      return;
    }
    if (ownerName.length < 2) {
      res.status(400).json({
        error: 'يرجى كتابة اسم الشخص صاحب البروموكود.',
      });
      return;
    }
    if (
      discountType === 'percent' &&
      (!Number.isFinite(discountValue) || discountValue < 1 || discountValue > 100)
    ) {
      res.status(400).json({
        error: 'نسبة الخصم يجب أن تكون بين 1% و 100%.',
      });
      return;
    }
    if (
      discountType === 'fixed' &&
      (!Number.isFinite(discountValue) || discountValue < 500)
    ) {
      res.status(400).json({
        error: 'مبلغ الخصم الثابت يجب أن يكون 500 د.ع فأكثر.',
      });
      return;
    }

    const rawDuration = req.body?.durationDays;
    let durationDays: number | null = null;
    let expiresAt: string | null = null;
    if (rawDuration !== undefined && rawDuration !== null && rawDuration !== '') {
      const parsedDays = Math.round(Number(rawDuration));
      if (!Number.isFinite(parsedDays) || parsedDays < 0 || parsedDays > 3650) {
        res.status(400).json({
          error: 'مدة الصلاحية بالأيام يجب أن تكون بين 0 (دائم) و 3650 يوم.',
        });
        return;
      }
      if (parsedDays > 0) {
        durationDays = parsedDays;
        expiresAt = new Date(Date.now() + parsedDays * 86_400_000).toISOString();
      }
    }

    const promoCode: PromoCode = {
      id: `pr-${crypto.randomUUID().slice(0, 8)}`,
      code,
      ownerName,
      discountType,
      discountValue,
      durationDays,
      expiresAt,
      active: true,
      timesUsed: 0,
      createdAt: new Date().toISOString(),
    };

    if (turso) {
      const existing = await turso.findPromoByCode(code);
      if (existing) {
        res.status(409).json({
          error: `الكود «${code}» موجود مسبقاً، يرجى اختيار كود مختلف.`,
        });
        return;
      }
      try {
        await turso.createPromoCode(promoCode);
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
      res.status(201).json({ promoCode });
      return;
    }

    const db = loadDatabase();
    if (db.promoCodes.some((p) => normalizePromoCode(p.code) === code)) {
      res.status(409).json({
        error: `الكود «${code}» موجود مسبقاً، يرجى اختيار كود مختلف.`,
      });
      return;
    }
    db.promoCodes.unshift(promoCode);
    saveDatabase(db);
    res.status(201).json({ promoCode });
  });

  app.patch('/api/admin/promo-codes/:id', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const patch: {
      active?: boolean;
      ownerName?: string;
      durationDays?: number | null;
      expiresAt?: string | null;
    } = {};

    if (typeof req.body?.active === 'boolean') patch.active = req.body.active;
    if (typeof req.body?.ownerName === 'string' && req.body.ownerName.trim()) {
      patch.ownerName = req.body.ownerName.trim();
    }
    if (req.body?.durationDays !== undefined) {
      const parsedDays = Math.round(Number(req.body.durationDays));
      if (
        req.body.durationDays === null ||
        req.body.durationDays === '' ||
        parsedDays === 0
      ) {
        patch.durationDays = null;
        patch.expiresAt = null;
      } else if (Number.isFinite(parsedDays) && parsedDays > 0 && parsedDays <= 3650) {
        patch.durationDays = parsedDays;
        patch.expiresAt = new Date(Date.now() + parsedDays * 86_400_000).toISOString();
      } else {
        res.status(400).json({
          error: 'مدة الصلاحية بالأيام يجب أن تكون بين 0 (دائم) و 3650 يوم.',
        });
        return;
      }
    }

    if (turso) {
      try {
        const updated = await turso.updatePromoCode(String(req.params.id ?? ''), patch);
        if (!updated) {
          res.status(404).json({ error: 'كود الخصم غير موجود.' });
          return;
        }
        res.json({ promoCode: updated });
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
      return;
    }

    const db = loadDatabase();
    const promo = db.promoCodes.find((p) => p.id === req.params.id);
    if (!promo) {
      res.status(404).json({ error: 'كود الخصم غير موجود.' });
      return;
    }
    Object.assign(promo, patch);
    saveDatabase(db);
    res.json({ promoCode: promo });
  });

  app.delete('/api/admin/promo-codes/:id', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    if (turso) {
      try {
        const deleted = await turso.deletePromoCode(String(req.params.id ?? ''));
        if (!deleted) {
          res.status(404).json({ error: 'كود الخصم غير موجود.' });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        if (err instanceof WriteFreezeError) {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
      return;
    }

    const db = loadDatabase();
    const before = db.promoCodes.length;
    db.promoCodes = db.promoCodes.filter((p) => p.id !== req.params.id);
    if (db.promoCodes.length === before) {
      res.status(404).json({ error: 'كود الخصم غير موجود.' });
      return;
    }
    saveDatabase(db);
    res.json({ ok: true });
  });

  // Admin Social Links CRUD
  app.post('/api/admin/social-links', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const platform =
      typeof req.body?.platform === 'string' ? req.body.platform.trim() : '';
    const label =
      typeof req.body?.label === 'string' ? req.body.label.trim() : platform;
    const handle =
      typeof req.body?.handle === 'string' ? req.body.handle.trim() : '';
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const url = sanitizeHref(rawUrl);

    if (!platform || !handle || url === '#') {
      res.status(400).json({
        error: 'يرجى إدخال اسم المنصة، المعرّف/الرقم، ورابط صحيح يبدأ بـ https://',
      });
      return;
    }

    const link: SocialLink = {
      id: `soc-${crypto.randomUUID().slice(0, 8)}`,
      platform,
      label: label || platform,
      handle,
      url,
    };

    if (turso) {
      const mirror = await getMirrorState();
      await turso.saveCatalogMirror({ socialLinks: [...mirror.socialLinks, link] });
      res.status(201).json({ socialLink: link });
      return;
    }

    const db = loadDatabase();
    db.socialLinks.push(link);
    saveDatabase(db);
    res.status(201).json({ socialLink: link });
  });

  app.put('/api/admin/social-links/:id', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const mirror = await getMirrorState();
    const nextSocials = mirror.socialLinks.map((s) => ({ ...s }));
    const link = nextSocials.find((s) => s.id === req.params.id);
    if (!link) {
      res.status(404).json({ error: 'رابط التواصل غير موجود.' });
      return;
    }
    if (typeof req.body?.platform === 'string' && req.body.platform.trim()) {
      link.platform = req.body.platform.trim();
    }
    if (typeof req.body?.label === 'string' && req.body.label.trim()) {
      link.label = req.body.label.trim();
    }
    if (typeof req.body?.handle === 'string' && req.body.handle.trim()) {
      link.handle = req.body.handle.trim();
    }
    if (typeof req.body?.url === 'string') {
      const safe = sanitizeHref(req.body.url);
      if (safe === '#') {
        res.status(400).json({ error: 'الرابط غير صالح.' });
        return;
      }
      link.url = safe;
    }

    if (turso) {
      await turso.saveCatalogMirror({ socialLinks: nextSocials });
      res.json({ socialLink: link });
      return;
    }

    const db = loadDatabase();
    db.socialLinks = nextSocials;
    saveDatabase(db);
    res.json({ socialLink: link });
  });

  app.delete('/api/admin/social-links/:id', requireAdmin, async (req, res) => {
    if (!(await ensureWritableRoute(res))) return;

    const mirror = await getMirrorState();
    const nextSocials = mirror.socialLinks.filter((s) => s.id !== req.params.id);
    if (nextSocials.length === mirror.socialLinks.length) {
      res.status(404).json({ error: 'رابط التواصل غير موجود.' });
      return;
    }

    if (turso) {
      await turso.saveCatalogMirror({ socialLinks: nextSocials });
      res.json({ ok: true });
      return;
    }

    const db = loadDatabase();
    db.socialLinks = nextSocials;
    saveDatabase(db);
    res.json({ ok: true });
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof WriteFreezeError) {
      res.status(503).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof StoreValidationError) {
      res.status(err.statusCode).json({
        error: err.message,
        ...(err.errors ? { errors: err.errors } : {}),
      });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'بيانات JSON المرسلة غير صالحة.' });
      return;
    }
    console.error('Unhandled API error:', err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع في الخادم.' });
  });

  return { app, turso, apiOnly };
}

async function startServer() {
  const { app, apiOnly } = createApp();
  const distDir = path.resolve(process.cwd(), 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distDir);

  if (apiOnly) {
    app.use('/api/*', (_req, res) => {
      res.status(404).json({ error: 'المسار غير موجود.' });
    });
    app.get('*', (_req, res) => {
      res.status(404).json({ error: 'API service only.' });
    });
  } else if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Blaugrana Perfumes server listening on http://0.0.0.0:${PORT}`);
  });
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint && process.env.BLAUGRANA_SKIP_AUTO_START !== '1') {
  void startServer();
}
