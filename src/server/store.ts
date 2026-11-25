import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  BLAUGRANA_DEFAULT_SIZE_PRICES,
  DEFAULT_STATUS_MESSAGES,
  FREE_DELIVERY_THRESHOLD_IQD,
  STANDARD_DELIVERY_FEE_IQD,
  buildVoucherCode,
  compareProductsByCode,
  normalizePhoneNumber,
  sanitizeHref,
  type AdminNotification,
  type CustomPerfumeRequest,
  type LoyaltyProfile,
  type Order,
  type Product,
  type PromoCode,
  type SocialLink,
  type StoreInfo,
} from '../utils/commerce.ts';
import { BLAUGRANA_62_PERFUMES } from './blaugranaCatalog.ts';
import { BRAND_56_PRODUCTS } from './brandCatalog.ts';
import { NEW_COLLECTION_PRODUCTS } from './newPerfumesCatalog.ts';

export interface AdminCredential {
  saltHex: string;
  hashHex: string;
  claimedAt: string;
}

export interface TelegramAlertConfig {
  botToken: string;
  chatId: string;
  updatedAt: string;
}

export interface DatabaseState {
  storeInfo: StoreInfo;
  products: Product[];
  socialLinks: SocialLink[];
  promoCodes: PromoCode[];
  orders: Order[];
  customRequests: CustomPerfumeRequest[];
  notifications: AdminNotification[];
  loyaltyByPhone: Record<string, LoyaltyProfile>;
  orderSequence: number;
  adminCredential: AdminCredential | null;
  telegramConfig: TelegramAlertConfig | null;
  sessionSecret?: string;
  deletedSeedIds?: string[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.resolve(DATA_DIR, 'blaugrana-db.json');

if (!DB_FILE.startsWith(DATA_DIR + path.sep)) {
  throw new Error('Invalid database path configuration');
}

const LEGACY_SEED_IDS = new Set([
  'bg-101',
  'bg-102',
  'bg-103',
  'bg-104',
  'bg-105',
  'bg-106',
]);

const FALLBACK_IMAGE = '/src/assets/images/perfume_signature_oud_1795208161900.jpg';
const OLD_GENERIC_FALLBACKS = new Set([
  '/src/assets/images/perfume_signature_oud_1795208161900.jpg',
  '/src/assets/images/perfume_crimson_rose_1795208162606.jpg',
  '/src/assets/images/product_body_mist_1795208162237.jpg',
]);

function normalizeProductRecord(product: Product): Product {
  const hasCustomImage =
    typeof product.hasCustomImage === 'boolean'
      ? product.hasCustomImage
      : product.category === 'blaugrana'
        ? product.imageUrl !== FALLBACK_IMAGE
        : true;

  let sizePrices = product.sizePrices;
  let priceIqd = product.priceIqd;
  let size = product.size;
  if (product.category === 'blaugrana' && !sizePrices) {
    sizePrices = { ...BLAUGRANA_DEFAULT_SIZE_PRICES };
    size = '100 مل';
    priceIqd = BLAUGRANA_DEFAULT_SIZE_PRICES['100 مل'];
  }

  return {
    ...product,
    priceIqd,
    size,
    ...(sizePrices ? { sizePrices } : {}),
    hasCustomImage,
  };
}

function createSeedState(): DatabaseState {
  const storeInfo: StoreInfo = {
    agencyName: 'وكالة بلوكرانا للعطور',
    locationText: 'العراق - ديالى - بعقوبة - التحرير - شارع الحسينية',
    city: 'ديالى - بعقوبة',
    freeDeliveryThresholdIqd: FREE_DELIVERY_THRESHOLD_IQD,
    standardDeliveryFeeIqd: STANDARD_DELIVERY_FEE_IQD,
    guaranteeTitle: 'ضمان الثبات والفوحان الذهبي + تيستر مجاني مع كل عطر',
    guaranteeText:
      'كل عطر تطلبه من وكالة بلوكرانا يصلك مع عينة تيستر مجانية للتجربة قبل فتح العبوة الأصلية، مع ضمان حقيقي للثبات والفوحان.',
  };

  const unsortedProducts: Product[] = [
    ...BLAUGRANA_62_PERFUMES,
    ...BRAND_56_PRODUCTS,
    ...NEW_COLLECTION_PRODUCTS,
    {
      id: 'ob-201',
      code: '201',
      name: 'ديور سوفاج إلكسير',
      brand: 'Dior',
      category: 'other_brands',
      priceIqd: 45000,
      size: '60 مل',
      topNotes: 'جوزة الطيب، القرفة، الهيل، الجريب فروت',
      heartNotes: 'الخزامى (اللافندر)',
      baseNotes: 'عرق السوس، خشب الصندل، العنبر، الباتشولي، نجيل الهند',
      notes: 'جوزة الطيب · خزامى · عرق السوس · خشب الصندل',
      longevity: '24 ساعة',
      sillage: 'فوحان فائق',
      description:
        'إصدار عالمي مكثف بتوابل دافئة وأخشاب عميقة، متوفر بضمان الوكالة مع تيستر مجاني.',
      imageUrl: '/assets/aistudio/IMG_0580_b7c8cdbb.JPG',
      hasCustomImage: true,
      includesFreeTester: true,
      inStock: true,
    },
    {
      id: 'ob-202',
      code: '202',
      name: 'توم فورد بلاك أوركيد',
      brand: 'Tom Ford',
      category: 'other_brands',
      priceIqd: 55000,
      size: '100 مل',
      topNotes: 'الكمأة السوداء، الغاردينيا، الكشمش الأسود، الإيلنغ',
      heartNotes: 'الأوركيد، التوابل، زهور اللوتس، الفواكه',
      baseNotes: 'الباتشولي، الفانيليا، البخور، الشوكولاتة الداكنة، خشب الصندل',
      notes: 'كمأة سوداء · أوركيد · باتشولي · شوكولاتة داكنة',
      longevity: '24 ساعة',
      sillage: 'فوحان فاخر',
      description:
        'عطر شرقي زهري أيقوني يجمع الغموض والجاذبية في زجاجة كلاسيكية.',
      imageUrl: '/assets/aistudio/IMG_0581_0b6c09db.JPG',
      hasCustomImage: true,
      includesFreeTester: true,
      inStock: true,
    },
    {
      id: 'ob-203',
      code: '203',
      name: 'كريد أفينتوس',
      brand: 'Creed',
      category: 'other_brands',
      priceIqd: 65000,
      size: '100 مل',
      topNotes: 'الأناناس، البرغموت، الكشمش الأسود، التفاح',
      heartNotes: 'خشب البتولا، الباتشولي، الياسمين المغربي، الورد',
      baseNotes: 'المسك، طحلب البلوط، الآمبرغريس، الفانيليا',
      notes: 'أناناس مدخن · برغموت · بتولا · مسك البلوط',
      longevity: '20 ساعة',
      sillage: 'فوحان ملكي',
      description:
        'أحد أشهر عطور النيش العالمية بحضور قيادي لا يخطئه الذوق الرفيع.',
      imageUrl: '/assets/aistudio/IMG_0582_0aac8e3d.JPG',
      hasCustomImage: true,
      includesFreeTester: true,
      inStock: true,
    },
    {
      id: 'ob-204',
      code: '204',
      name: 'لطافة خمرة',
      brand: 'Lattafa',
      category: 'other_brands',
      priceIqd: 24000,
      size: '100 مل',
      topNotes: 'القرفة، جوزة الطيب، البرغموت',
      heartNotes: 'التمر، البرالين، مسك الروم، زهر الماهونيا',
      baseNotes: 'الفانيليا، حبوب التونكا، العنبر، خشب أكيغالا، الجاوي',
      notes: 'قرفة · تمر · برالين · فانيليا · تونكا',
      longevity: '20 ساعة',
      sillage: 'فوحان دافئ',
      description:
        'إصدار عربي محبوب بنفحات حلوة وتوابل دافئة مثالية للأجواء المسائية.',
      imageUrl: '/assets/aistudio/IMG_0583_8dfb6640.JPG',
      hasCustomImage: true,
      includesFreeTester: true,
      inStock: true,
    },
    {
      id: 'bm-301',
      code: '301',
      name: 'معطر جسم فانيليا وعنبر',
      brand: 'بلوكرانا كير',
      category: 'body_mist',
      priceIqd: 10000,
      size: '250 مل',
      topNotes: 'زهر اللوز، الكمثرى',
      heartNotes: 'الفانيليا الدافئة، الياسمين',
      baseNotes: 'العنبر الذهبي، خشب الصندل، المسك',
      notes: 'فانيليا دافئة · عنبر ذهبي · خشب الصندل',
      longevity: '10 ساعات',
      sillage: 'انتشار ناعم',
      description:
        'معطر جسم لطيف على البشرة يمنحك ترطيباً عطرياً يدوم طويلاً بعد الاستحمام.',
      imageUrl: '/src/assets/images/product_body_mist_1795208162237.jpg',
      hasCustomImage: true,
      includesFreeTester: false,
      inStock: true,
    },
    {
      id: 'bm-302',
      code: '302',
      name: 'معطر جسم زهرة الكرز والمسك',
      brand: 'بلوكرانا كير',
      category: 'body_mist',
      priceIqd: 10000,
      size: '250 مل',
      topNotes: 'الكمثرى، اليوسفي',
      heartNotes: 'زهرة الكرز، الفاوانيا',
      baseNotes: 'المسك الأبيض، خشب الأرز',
      notes: 'زهرة الكرز · مسك أبيض · كمثرى',
      longevity: '10 ساعات',
      sillage: 'انتشار منعش',
      description:
        'رذاذ جسم خفيف بنفحات زهرية ناعمة مثالي للاستخدام اليومي المتكرر.',
      imageUrl: '/src/assets/images/product_body_mist_1795208162237.jpg',
      hasCustomImage: true,
      includesFreeTester: false,
      inStock: true,
    },
    {
      id: 'dd-401',
      code: '401',
      name: 'مزيل عرق بلوكرانا سيلفر',
      brand: 'بلوكرانا كير',
      category: 'deodorant',
      priceIqd: 8000,
      size: '50 مل',
      topNotes: 'البرغموت، الليمون المنعش',
      heartNotes: 'الخزامى، الشاي الأخضر',
      baseNotes: 'خشب الأرز الأبيض، المسك النظيف',
      notes: 'برغموت · أرز أبيض · خالٍ من الكحول',
      longevity: '48 ساعة',
      sillage: 'حماية ونظافة',
      description:
        'تركيبة طبية آمنة لا تترك أثراً على الملابس وتمنح حماية فعالة طوال اليوم.',
      imageUrl: '/src/assets/images/product_body_mist_1795208162237.jpg',
      hasCustomImage: true,
      includesFreeTester: false,
      inStock: true,
    },
    {
      id: 'dd-402',
      code: '402',
      name: 'مزيل عرق بالعود والمسك',
      brand: 'بلوكرانا كير',
      category: 'deodorant',
      priceIqd: 8500,
      size: '50 مل',
      topNotes: 'خلاصة الألوفيرا، الهيل الخفيف',
      heartNotes: 'العود الأبيض، الورد الناعم',
      baseNotes: 'المسك الأبيض، خشب الصندل',
      notes: 'مسك ناعم · عود أبيض · خلاصة الألوفيرا',
      longevity: '48 ساعة',
      sillage: 'عبق شرقي',
      description:
        'حماية طويلة الأمد مع نفحة عود ومسك هادئة تنسجم مع عطرك المفضل.',
      imageUrl: '/src/assets/images/product_body_mist_1795208162237.jpg',
      hasCustomImage: true,
      includesFreeTester: false,
      inStock: true,
    },
    {
      id: 'ts-501',
      code: '501',
      name: 'بوكس تيسترات بلوكرانا (5 عينات)',
      brand: 'بلوكرانا',
      category: 'tester',
      priceIqd: 12000,
      size: '5 × 5 مل',
      notes: 'تشكيلة عطورنا الأكثر طلباً للتجربة',
      longevity: '24 ساعة',
      sillage: 'حسب العطر',
      description:
        'مجموعة 5 تيسترات زجاجية برذاذ نحاسي لاختبار الثبات والفوحان قبل اقتناء الحجم الكامل.',
      imageUrl: '/src/assets/images/product_tester_kit_1795208162880.jpg',
      hasCustomImage: true,
      includesFreeTester: false,
      inStock: true,
    },
    {
      id: 'ts-502',
      code: '502',
      name: 'تيستر عطر مختار للتجربة',
      brand: 'بلوكرانا',
      category: 'tester',
      priceIqd: 5000,
      size: '10 مل',
      notes: 'اختر أي رقم عطر لتجربته بحجم السفر',
      longevity: '24 ساعة',
      sillage: 'مركز',
      description:
        'عبوة تيستر مركزة بحجم الجيب لتجربة أي عطر من الوكالة مع ضمان الثبات الكامل.',
      imageUrl: '/src/assets/images/product_tester_kit_1795208162880.jpg',
      hasCustomImage: true,
      includesFreeTester: false,
      inStock: true,
    },
  ];
  const products = unsortedProducts.sort(compareProductsByCode);

  const socialLinks: SocialLink[] = [
    {
      id: 'soc-whatsapp',
      platform: 'واتساب',
      label: 'واتساب الوكالة',
      handle: '07745306712',
      url: 'https://wa.me/9647745306712',
    },
    {
      id: 'soc-instagram',
      platform: 'انستغرام',
      label: 'انستغرام',
      handle: '@blaugrana.perfumes',
      url: 'https://instagram.com/blaugrana.perfumes',
    },
    {
      id: 'soc-tiktok',
      platform: 'تيك توك',
      label: 'تيك توك',
      handle: '@blaugrana.perfumes',
      url: 'https://tiktok.com/@blaugrana.perfumes',
    },
  ];

  return {
    storeInfo,
    products,
    socialLinks,
    promoCodes: [],
    orders: [],
    customRequests: [],
    notifications: [],
    loyaltyByPhone: {},
    orderSequence: 1001,
    adminCredential: null,
    telegramConfig: null,
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    deletedSeedIds: [],
  };
}

function normalizeOrderRecord(order: Order): Order {
  const status = order.status ?? 'تم الاستلام';
  return {
    ...order,
    status,
    estimatedArrival: order.estimatedArrival || 'خلال 24 إلى 48 ساعة',
    statusMessage:
      order.statusMessage || DEFAULT_STATUS_MESSAGES[status] || DEFAULT_STATUS_MESSAGES['تم الاستلام'],
    statusHistory:
      Array.isArray(order.statusHistory) && order.statusHistory.length > 0
        ? order.statusHistory
        : [{ status, timestamp: order.createdAt }],
  };
}

export function loadDatabase(): DatabaseState {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    const seed = createSeedState();
    saveDatabase(seed);
    return seed;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DatabaseState>;
    const seed = createSeedState();
    let products: Product[] = Array.isArray(parsed.products)
      ? parsed.products.map(normalizeProductRecord)
      : seed.products;

    const deletedSeedIds = Array.isArray(parsed.deletedSeedIds)
      ? parsed.deletedSeedIds.filter((id): id is string => typeof id === 'string')
      : [];
    const deletedSeedSet = new Set(deletedSeedIds);

    let migrated = false;
    const hasBlaugrana62 = products.some((p) => p.id === 'bg-m01');
    if (!hasBlaugrana62) {
      const nonLegacy = products.filter((p) => !LEGACY_SEED_IDS.has(p.id));
      const existingIds = new Set(nonLegacy.map((p) => p.id));
      const missingSeeds = seed.products.filter(
        (p) => !existingIds.has(p.id) && !deletedSeedSet.has(p.id)
      );
      products = [...missingSeeds, ...nonLegacy];
      migrated = true;
    } else {
      const existingIds = new Set(products.map((p) => p.id));
      const missingBrands = BRAND_56_PRODUCTS.filter(
        (p) => !existingIds.has(p.id) && !deletedSeedSet.has(p.id)
      );
      const missingNewCollection = NEW_COLLECTION_PRODUCTS.filter(
        (p) => !existingIds.has(p.id) && !deletedSeedSet.has(p.id)
      );
      if (missingBrands.length > 0 || missingNewCollection.length > 0) {
        products = [...products, ...missingBrands, ...missingNewCollection];
        migrated = true;
      }
    }

    // Sync newly mapped /assets/aistudio/ seed photos onto any seed items
    // still using an old fallback placeholder without clobbering admin-edited URLs.
    const seedById = new Map(seed.products.map((p) => [p.id, p]));
    products = products.map((product) => {
      const seeded = seedById.get(product.id);
      if (!seeded || !seeded.imageUrl.startsWith('/assets/aistudio/')) {
        return product;
      }
      const isStillPlaceholder =
        product.hasCustomImage === false ||
        OLD_GENERIC_FALLBACKS.has(product.imageUrl);
      if (isStillPlaceholder && product.imageUrl !== seeded.imageUrl) {
        migrated = true;
        return {
          ...product,
          imageUrl: seeded.imageUrl,
          hasCustomImage: true,
        };
      }
      return product;
    });

    products.sort(compareProductsByCode);

    const sessionSecret =
      typeof parsed.sessionSecret === 'string' && parsed.sessionSecret.length >= 16
        ? parsed.sessionSecret
        : seed.sessionSecret;
    if (!parsed.sessionSecret) {
      migrated = true;
    }

    const promoCodes: PromoCode[] = Array.isArray(parsed.promoCodes)
      ? parsed.promoCodes.map((p) => ({
          ...p,
          durationDays:
            typeof p.durationDays === 'number' && Number.isFinite(p.durationDays)
              ? p.durationDays
              : null,
          expiresAt:
            typeof p.expiresAt === 'string' && p.expiresAt.trim()
              ? p.expiresAt.trim()
              : null,
        }))
      : [];

    const state: DatabaseState = {
      storeInfo: parsed.storeInfo ?? seed.storeInfo,
      products,
      socialLinks: Array.isArray(parsed.socialLinks)
        ? parsed.socialLinks.map((s) => ({
            ...s,
            url: sanitizeHref(s.url),
          }))
        : seed.socialLinks,
      promoCodes,
      orders: Array.isArray(parsed.orders)
        ? parsed.orders.map(normalizeOrderRecord)
        : [],
      customRequests: Array.isArray(parsed.customRequests)
        ? parsed.customRequests
        : [],
      notifications: Array.isArray(parsed.notifications)
        ? parsed.notifications
        : [],
      loyaltyByPhone:
        parsed.loyaltyByPhone && typeof parsed.loyaltyByPhone === 'object'
          ? parsed.loyaltyByPhone
          : {},
      orderSequence:
        typeof parsed.orderSequence === 'number' ? parsed.orderSequence : 1001,
      adminCredential: parsed.adminCredential ?? null,
      telegramConfig: parsed.telegramConfig ?? null,
      sessionSecret,
      deletedSeedIds,
    };

    if (migrated) {
      saveDatabase(state);
    }

    return state;
  } catch {
    const seed = createSeedState();
    saveDatabase(seed);
    return seed;
  }
}

export function saveDatabase(state: DatabaseState): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpFile = path.resolve(
    DATA_DIR,
    `blaugrana-db.${crypto.randomUUID()}.tmp`
  );
  if (!tmpFile.startsWith(DATA_DIR + path.sep)) {
    throw new Error('Invalid temp database path');
  }
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpFile, DB_FILE);
}

export function getOrCreateLoyaltyProfile(
  db: DatabaseState,
  phoneRaw: string
): LoyaltyProfile {
  const phone = normalizePhoneNumber(phoneRaw);
  const existing = db.loyaltyByPhone[phone];
  if (existing) {
    return existing;
  }
  return {
    phone,
    totalQualifyingPerfumes: 0,
    stamps: 0,
    stampsRemainingForFree: 5,
    freePerfumesRedeemed: 0,
    voucherCode: buildVoucherCode(phone),
    ordersCount: 0,
  };
}
