export type ProductCategory =
  | 'blaugrana'
  | 'other_brands'
  | 'body_mist'
  | 'room_spray'
  | 'deodorant'
  | 'hair_care'
  | 'tester';

export type OrderStatus =
  | 'تم الاستلام'
  | 'قيد المراجعة'
  | 'تم التجهيز'
  | 'قيد التوصيل'
  | 'تم التسليم';

export type CustomRequestStatus =
  | 'قيد البحث'
  | 'تم التوفير'
  | 'تم التواصل';

export type NoteFamilyId =
  | 'all'
  | 'oud_incense'
  | 'amber_vanilla'
  | 'citrus_fresh'
  | 'floral'
  | 'musk_woods'
  | 'spices_leather';

export const BLAUGRANA_SIZE_ORDER = ['30 مل', '50 مل', '100 مل'] as const;

export const BLAUGRANA_DEFAULT_SIZE_PRICES: Record<string, number> = {
  '30 مل': 10000,
  '50 مل': 18000,
  '100 مل': 30000,
};

export interface Product {
  id: string;
  code: string;
  name: string;
  brand: string;
  category: ProductCategory;
  priceIqd: number;
  size: string;
  sizePrices?: Record<string, number>;
  notes: string;
  topNotes?: string;
  heartNotes?: string;
  baseNotes?: string;
  longevity: string;
  sillage: string;
  description: string;
  imageUrl: string;
  hasCustomImage?: boolean;
  includesFreeTester: boolean;
  inStock: boolean;
}

export type PromoDiscountType = 'percent' | 'fixed';

export interface PromoCode {
  id: string;
  code: string;
  ownerName: string;
  discountType: PromoDiscountType;
  discountValue: number;
  durationDays?: number | null;
  expiresAt?: string | null;
  active: boolean;
  timesUsed: number;
  createdAt: string;
}

export interface AppliedPromoPreview {
  code: string;
  ownerName: string;
  discountType: PromoDiscountType;
  discountValue: number;
  expiresAt?: string | null;
}

export interface SocialLink {
  id: string;
  platform: string;
  label: string;
  handle: string;
  url: string;
}

export interface StoreInfo {
  agencyName: string;
  locationText: string;
  city: string;
  freeDeliveryThresholdIqd: number;
  standardDeliveryFeeIqd: number;
  guaranteeTitle: string;
  guaranteeText: string;
}

export interface CartItemInput {
  product: Product;
  quantity: number;
  selectedSize?: string;
}

export interface CartSummary {
  totalItemsCount: number;
  qualifyingPerfumeUnits: number;
  freeTestersCount: number;
  freePerfumeUnitsEarned: number;
  loyaltyDiscountIqd: number;
  promoDiscountIqd: number;
  promoCode?: string;
  promoOwnerName?: string;
  rawSubtotalIqd: number;
  subtotalAfterDiscountIqd: number;
  deliveryFeeIqd: number;
  qualifiesForFreeDelivery: boolean;
  amountToFreeDeliveryIqd: number;
  totalIqd: number;
  priorPerfumeUnits: number;
  stampsBefore: number;
  stampsAfter: number;
  stampsNeededForNextFree: number;
}

export interface OrderItem {
  productId: string;
  code: string;
  name: string;
  brand: string;
  category: ProductCategory;
  size?: string;
  priceIqd: number;
  quantity: number;
  includesFreeTester: boolean;
}

export interface OrderStatusEvent {
  status: OrderStatus;
  timestamp: string;
  note?: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  createdAt: string;
  fullName: string;
  exactLocation: string;
  birthDate: string;
  phone: string;
  items: OrderItem[];
  pricing: CartSummary;
  voucherCode: string;
  status: OrderStatus;
  estimatedArrival: string;
  statusMessage: string;
  statusHistory: OrderStatusEvent[];
  deliveredAt?: string;
}

export interface AdminNotification {
  id: string;
  createdAt: string;
  type: 'new_order' | 'custom_request';
  orderId?: string;
  orderNumber?: string;
  customerName: string;
  customerPhone: string;
  exactLocation?: string;
  totalIqd?: number;
  itemsSummary: string;
  message: string;
  read: boolean;
}

export interface CustomPerfumeRequest {
  id: string;
  createdAt: string;
  perfumeName: string;
  expectedPriceIqd: number;
  size: string;
  desiredDate: string;
  customerName: string;
  customerPhone: string;
  notes: string;
  status: CustomRequestStatus;
}

export interface LoyaltyProfile {
  phone: string;
  totalQualifyingPerfumes: number;
  stamps: number;
  stampsRemainingForFree: number;
  freePerfumesRedeemed: number;
  voucherCode: string;
  ordersCount: number;
}

export const FREE_DELIVERY_THRESHOLD_IQD = 20000;
export const STANDARD_DELIVERY_FEE_IQD = 5000;
export const LOYALTY_CYCLE_SIZE = 5; // Buy 4, 5th is free

export const CATEGORY_LABELS: Record<ProductCategory, string> = {
  blaugrana: 'عطور بلوكرانا الخاصة',
  other_brands: 'عطور شركات أخرى',
  body_mist: 'معطرات الجسم والبخاخات',
  room_spray: 'معطرات الجو والأقمشة',
  deodorant: 'مزيلات العرق',
  hair_care: 'شامبو هير وعناية بالشعر',
  tester: 'تيسترات التجربة',
};

export const NOTE_FAMILIES: Array<{
  id: NoteFamilyId;
  label: string;
  keywords: string[];
}> = [
  { id: 'all', label: 'كل النوتات العطرية', keywords: [] },
  {
    id: 'oud_incense',
    label: 'العود والبخور',
    keywords: ['عود', 'بخور', 'لبان', 'جاوي', 'بنزوين', 'دخان'],
  },
  {
    id: 'amber_vanilla',
    label: 'العنبر والفانيليا والتونكا',
    keywords: [
      'عنبر',
      'فانيليا',
      'فانيلا',
      'تونكا',
      'كراميل',
      'عسل',
      'شوكولاتة',
      'كاكاو',
      'برالين',
      'سكر',
      'مارشميلو',
      'فستق',
      'آيس كريم',
      'بندق',
      'لوز',
      'قهوة',
    ],
  },
  {
    id: 'citrus_fresh',
    label: 'الحمضيات والانتعاش والفواكه',
    keywords: [
      'برغموت',
      'ليمون',
      'برتقال',
      'ماندرين',
      'جريب فروت',
      'بحر',
      'مائية',
      'نعناع',
      'يوسفي',
      'تفاح',
      'أناناس',
      'رمان',
      'توت',
      'خوخ',
      'كمثرى',
      'كرز',
      'ليتشي',
      'فراولة',
    ],
  },
  {
    id: 'floral',
    label: 'الأزهار والياسمين والورد',
    keywords: [
      'ورد',
      'ياسمين',
      'فريزيا',
      'توليب',
      'سوسن',
      'زنبق',
      'غاردينيا',
      'زهر',
      'أزهار',
      'بنفسج',
      'خزامى',
      'لافندر',
      'ماغنوليا',
      'أوركيد',
      'فاوانيا',
    ],
  },
  {
    id: 'musk_woods',
    label: 'المسك والأخشاب',
    keywords: [
      'مسك',
      'أرز',
      'صندل',
      'باتشولي',
      'نجيل الهند',
      'طحلب',
      'طحالب',
      'أخشاب',
      'خشب',
      'باودر',
      'بودرة',
    ],
  },
  {
    id: 'spices_leather',
    label: 'التوابل والجلود والتبغ',
    keywords: [
      'فلفل',
      'قرفة',
      'هيل',
      'زعفران',
      'جلد',
      'تبغ',
      'زنجبيل',
      'توابل',
      'قرنفل',
      'جوزة الطيب',
      'كمون',
      'يانسون',
    ],
  },
];

export function matchesNoteFamily(
  product: Product,
  familyId: NoteFamilyId
): boolean {
  if (familyId === 'all') return true;
  const family = NOTE_FAMILIES.find((f) => f.id === familyId);
  if (!family || family.keywords.length === 0) return true;
  const haystack = [
    product.notes,
    product.topNotes ?? '',
    product.heartNotes ?? '',
    product.baseNotes ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return family.keywords.some((kw) => haystack.includes(kw.toLowerCase()));
}

function extractCodeSortKey(code: string): { prefix: string; num: number } {
  const normalized = code.trim().toUpperCase().replace(/[°\-\s]+/g, '');
  const match = normalized.match(/^([A-Z0-9]*?)(\d+)$/);
  if (!match) {
    return { prefix: normalized, num: Number.MAX_SAFE_INTEGER };
  }
  const lettersOnly = normalized.match(/^([A-Z]+)(\d+)$/);
  if (lettersOnly) {
    return { prefix: lettersOnly[1], num: Number(lettersOnly[2]) };
  }
  return {
    prefix: match[1] || '',
    num: Number(match[2]),
  };
}

export function compareProductsByCode(a: Product, b: Product): number {
  const ka = extractCodeSortKey(a.code);
  const kb = extractCodeSortKey(b.code);

  // M01..M65 first in strict ascending order
  if (ka.prefix === 'M' && kb.prefix !== 'M') return -1;
  if (ka.prefix !== 'M' && kb.prefix === 'M') return 1;
  if (ka.prefix === kb.prefix) {
    if (ka.num !== kb.num) return ka.num - kb.num;
  }
  return a.code.localeCompare(b.code, 'ar');
}

export function isQualifyingPerfumeCategory(category: ProductCategory): boolean {
  return category === 'blaugrana' || category === 'other_brands';
}

export function formatIQD(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
  return `${safe.toLocaleString('en-US')} د.ع`;
}

export function normalizePhoneNumber(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+964')) {
    return `0${digits.slice(4)}`;
  }
  if (digits.startsWith('964') && digits.length >= 12) {
    return `0${digits.slice(3)}`;
  }
  return digits;
}

export function getProductSizeOptions(
  product: Product
): Array<{ size: string; priceIqd: number }> {
  if (!product.sizePrices) {
    return [{ size: product.size, priceIqd: product.priceIqd }];
  }
  const entries = Object.entries(product.sizePrices).filter(
    ([size, price]) => size.trim().length > 0 && Number.isFinite(price) && price > 0
  );
  if (entries.length === 0) {
    return [{ size: product.size, priceIqd: product.priceIqd }];
  }
  entries.sort(([a], [b]) => {
    const idxA = BLAUGRANA_SIZE_ORDER.indexOf(a as (typeof BLAUGRANA_SIZE_ORDER)[number]);
    const idxB = BLAUGRANA_SIZE_ORDER.indexOf(b as (typeof BLAUGRANA_SIZE_ORDER)[number]);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    const numA = Number.parseFloat(a);
    const numB = Number.parseFloat(b);
    if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) {
      return numA - numB;
    }
    return a.localeCompare(b, 'ar');
  });
  return entries.map(([size, priceIqd]) => ({ size, priceIqd }));
}

export function resolveProductUnitPrice(
  product: Product,
  selectedSize?: string
): { size: string; priceIqd: number } {
  const options = getProductSizeOptions(product);
  const requested = selectedSize?.trim();
  if (requested) {
    const matched = options.find((opt) => opt.size === requested);
    if (matched) return matched;
  }
  const primaryMatch = options.find((opt) => opt.size === product.size);
  if (primaryMatch) return primaryMatch;
  return options[options.length - 1] ?? { size: product.size, priceIqd: product.priceIqd };
}

export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export interface PromoValidityResult {
  valid: boolean;
  expired: boolean;
  remainingDays: number | null;
}

export function isPromoCodeValidNow(
  promo: Pick<PromoCode, 'active' | 'expiresAt'>,
  nowMs = Date.now()
): PromoValidityResult {
  if (!promo.expiresAt) {
    return {
      valid: Boolean(promo.active),
      expired: false,
      remainingDays: null,
    };
  }
  const expiresMs = Date.parse(promo.expiresAt);
  if (!Number.isFinite(expiresMs)) {
    return {
      valid: Boolean(promo.active),
      expired: false,
      remainingDays: null,
    };
  }
  const diffMs = expiresMs - nowMs;
  if (diffMs <= 0) {
    return {
      valid: false,
      expired: true,
      remainingDays: 0,
    };
  }
  return {
    valid: Boolean(promo.active),
    expired: false,
    remainingDays: Math.ceil(diffMs / 86_400_000),
  };
}

export function calculatePromoDiscount(
  subtotalAfterLoyaltyIqd: number,
  promo?: AppliedPromoPreview | null
): number {
  if (!promo || subtotalAfterLoyaltyIqd <= 0) return 0;
  if (promo.discountType === 'percent') {
    const pct = Math.min(100, Math.max(0, promo.discountValue));
    return Math.min(
      subtotalAfterLoyaltyIqd,
      Math.round((subtotalAfterLoyaltyIqd * pct) / 100)
    );
  }
  return Math.min(
    subtotalAfterLoyaltyIqd,
    Math.max(0, Math.round(promo.discountValue))
  );
}

export function calculateCartSummary(
  items: CartItemInput[],
  priorPerfumeUnits = 0,
  promo?: AppliedPromoPreview | null
): CartSummary {
  const safePrior = Math.max(0, Math.floor(priorPerfumeUnits));
  let totalItemsCount = 0;
  let qualifyingPerfumeUnits = 0;
  let freeTestersCount = 0;
  let rawSubtotalIqd = 0;
  const qualifyingUnitPrices: number[] = [];

  for (const item of items) {
    const qty = Math.max(0, Math.floor(item.quantity));
    if (qty === 0) continue;

    const resolved = resolveProductUnitPrice(item.product, item.selectedSize);
    totalItemsCount += qty;
    rawSubtotalIqd += resolved.priceIqd * qty;

    if (isQualifyingPerfumeCategory(item.product.category)) {
      qualifyingPerfumeUnits += qty;
      for (let i = 0; i < qty; i += 1) {
        qualifyingUnitPrices.push(resolved.priceIqd);
      }
    }

    if (
      item.product.includesFreeTester ||
      isQualifyingPerfumeCategory(item.product.category)
    ) {
      freeTestersCount += qty;
    }
  }

  const totalAfter = safePrior + qualifyingPerfumeUnits;
  const freePerfumeUnitsEarned =
    Math.floor(totalAfter / LOYALTY_CYCLE_SIZE) -
    Math.floor(safePrior / LOYALTY_CYCLE_SIZE);

  qualifyingUnitPrices.sort((a, b) => a - b);
  let loyaltyDiscountIqd = 0;
  for (
    let i = 0;
    i < Math.min(freePerfumeUnitsEarned, qualifyingUnitPrices.length);
    i += 1
  ) {
    loyaltyDiscountIqd += qualifyingUnitPrices[i];
  }

  const afterLoyaltyIqd = Math.max(0, rawSubtotalIqd - loyaltyDiscountIqd);
  const promoDiscountIqd = calculatePromoDiscount(afterLoyaltyIqd, promo);
  const subtotalAfterDiscountIqd = Math.max(0, afterLoyaltyIqd - promoDiscountIqd);

  const qualifiesForFreeDelivery =
    totalItemsCount > 0 &&
    subtotalAfterDiscountIqd >= FREE_DELIVERY_THRESHOLD_IQD;

  const deliveryFeeIqd =
    totalItemsCount === 0
      ? 0
      : qualifiesForFreeDelivery
        ? 0
        : STANDARD_DELIVERY_FEE_IQD;

  const amountToFreeDeliveryIqd =
    totalItemsCount === 0
      ? FREE_DELIVERY_THRESHOLD_IQD
      : Math.max(0, FREE_DELIVERY_THRESHOLD_IQD - subtotalAfterDiscountIqd);

  const totalIqd = subtotalAfterDiscountIqd + deliveryFeeIqd;

  const stampsBefore = safePrior % LOYALTY_CYCLE_SIZE;
  const stampsAfter = totalAfter % LOYALTY_CYCLE_SIZE;
  const stampsNeededForNextFree =
    stampsAfter === 0 ? LOYALTY_CYCLE_SIZE : LOYALTY_CYCLE_SIZE - stampsAfter;

  return {
    totalItemsCount,
    qualifyingPerfumeUnits,
    freeTestersCount,
    freePerfumeUnitsEarned,
    loyaltyDiscountIqd,
    promoDiscountIqd,
    ...(promo && promoDiscountIqd > 0
      ? { promoCode: promo.code, promoOwnerName: promo.ownerName }
      : {}),
    rawSubtotalIqd,
    subtotalAfterDiscountIqd,
    deliveryFeeIqd,
    qualifiesForFreeDelivery,
    amountToFreeDeliveryIqd,
    totalIqd,
    priorPerfumeUnits: safePrior,
    stampsBefore,
    stampsAfter,
    stampsNeededForNextFree,
  };
}

export function sanitizeHref(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '#';
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === 'https:' ||
      parsed.protocol === 'http:' ||
      parsed.protocol === 'tel:'
    ) {
      return parsed.toString();
    }
    return '#';
  } catch {
    return '#';
  }
}

const DATA_IMAGE_REGEX =
  /^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

export function sanitizeImageInput(
  rawUrl: unknown,
  fallback = '/src/assets/images/perfume_signature_oud_1795208161900.jpg'
): string {
  if (typeof rawUrl !== 'string') return fallback;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.includes('..')) return fallback;

  if (
    trimmed.startsWith('/src/assets/') ||
    trimmed.startsWith('/assets/aistudio/') ||
    trimmed.startsWith('/uploads/') ||
    trimmed.startsWith('/api/images/')
  ) {
    return trimmed;
  }

  if (DATA_IMAGE_REGEX.test(trimmed)) {
    return trimmed;
  }

  const normalizedCandidate = trimmed.startsWith('//')
    ? `https:${trimmed}`
    : !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed) &&
        /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/|$)/.test(trimmed)
      ? `https://${trimmed}`
      : trimmed;

  try {
    const parsed = new URL(normalizedCandidate);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function buildVoucherCode(phone: string): string {
  const normalized = normalizePhoneNumber(phone);
  const tail = normalized.slice(-4).padStart(4, '0');
  return `BG-VIP-${tail}`;
}

export interface CheckoutValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export function validateCheckoutInput(input: {
  fullName: string;
  exactLocation: string;
  birthDate: string;
  phone: string;
  itemsCount: number;
}): CheckoutValidationResult {
  const errors: Record<string, string> = {};
  if (input.itemsCount <= 0) {
    errors.items = 'يرجى إضافة منتج واحد على الأقل إلى السلة.';
  }
  if (input.fullName.trim().length < 3) {
    errors.fullName = 'يرجى إدخال الاسم الكامل (3 أحرف على الأقل).';
  }
  if (input.exactLocation.trim().length < 5) {
    errors.exactLocation = 'يرجى كتابة الموقع بالتحديد (المحافظة، المنطقة، أقرب نقطة دالة).';
  }
  if (!input.birthDate.trim()) {
    errors.birthDate = 'يرجى تحديد تاريخ الميلاد.';
  }
  const normalizedPhone = normalizePhoneNumber(input.phone);
  if (!/^07\d{9}$/.test(normalizedPhone) && normalizedPhone.length < 10) {
    errors.phone = 'يرجى إدخال رقم هاتف عراقي صحيح (مثال: 07745306712).';
  }
  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function validateCustomRequestInput(input: {
  perfumeName: string;
  expectedPriceIqd: number;
  size: string;
  desiredDate: string;
  customerName: string;
  customerPhone: string;
}): CheckoutValidationResult {
  const errors: Record<string, string> = {};
  if (input.perfumeName.trim().length < 2) {
    errors.perfumeName = 'يرجى إدخال اسم العطر المطلوب.';
  }
  if (!Number.isFinite(input.expectedPriceIqd) || input.expectedPriceIqd <= 0) {
    errors.expectedPriceIqd = 'يرجى تحديد السعر المتوقع بالدينار العراقي.';
  }
  if (input.size.trim().length < 2) {
    errors.size = 'يرجى تحديد الحجم المطلوب (مثال: 100 مل).';
  }
  if (!input.desiredDate.trim()) {
    errors.desiredDate = 'يرجى اختيار التاريخ المطلوب للتوصيل.';
  }
  if (input.customerName.trim().length < 2) {
    errors.customerName = 'يرجى إدخال اسمك للتواصل.';
  }
  const normalizedPhone = normalizePhoneNumber(input.customerPhone);
  if (normalizedPhone.length < 10) {
    errors.customerPhone = 'يرجى إدخال رقم هاتف صحيح للتواصل.';
  }
  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export const ORDER_PROGRESS_STEPS: readonly OrderStatus[] = [
  'تم الاستلام',
  'تم التجهيز',
  'قيد التوصيل',
  'تم التسليم',
];

export const DEFAULT_STATUS_MESSAGES: Record<OrderStatus, string> = {
  'تم الاستلام':
    'تم استلام طلبك بنجاح وجاري مراجعته لتجهيز العطور والتيستر المجاني.',
  'قيد المراجعة':
    'تم استلام طلبك بنجاح وجاري مراجعته لتجهيز العطور والتيستر المجاني.',
  'تم التجهيز':
    'تم تجهيز عطرك وفحص الثبات والفوحان وإرفاق التيستر المجاني، وبانتظار انطلاق المندوب.',
  'قيد التوصيل':
    'طلبك خرج للتوصيل الآن مع المندوب وسيصلك في الموعد المحدد.',
  'تم التسليم':
    'تم تسليم طلبك بنجاح! نتمنى لك تجربة عطرية مميزة من وكالة بلوكرانا.',
};

export function getOrderProgressStepIndex(status: OrderStatus): number {
  if (status === 'تم التسليم') return 3;
  if (status === 'قيد التوصيل') return 2;
  if (status === 'تم التجهيز') return 1;
  return 0;
}

export function buildWhatsAppUrl(phone: string, text: string): string {
  const digits = normalizePhoneNumber(phone).replace(/[^\d]/g, '');
  const intl = digits.startsWith('0')
    ? `964${digits.slice(1)}`
    : digits.startsWith('964')
      ? digits
      : `964${digits}`;
  return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
}

export function buildOwnerOrderAlertMessage(order: Order): string {
  const itemsLines = order.items
    .map(
      (it) =>
        `• #${it.code} ${it.name}${it.size ? ` (${it.size})` : ''} × ${it.quantity}${it.includesFreeTester ? ' (+تيستر مجاني)' : ''}`
    )
    .join('\n');
  const deliveryText = order.pricing.qualifiesForFreeDelivery
    ? 'مجاني'
    : formatIQD(order.pricing.deliveryFeeIqd);
  const lines = [
    `🔔 طلب جديد من متجر بلوكرانا للعطور — ${order.orderNumber}`,
    `👤 الزبون: ${order.fullName}`,
    `📱 الهاتف: ${order.phone}`,
    `📍 الموقع بالتحديد: ${order.exactLocation}`,
    `🛍️ المنتجات:`,
    itemsLines,
    `🎁 التيسترات المجانية: ${order.pricing.freeTestersCount}`,
    `🚚 التوصيل: ${deliveryText}`,
  ];
  if (order.pricing.promoCode && order.pricing.promoDiscountIqd > 0) {
    lines.push(
      `🏷️ بروموكود (${order.pricing.promoCode} — ${order.pricing.promoOwnerName ?? ''}): -${formatIQD(order.pricing.promoDiscountIqd)}`
    );
  }
  lines.push(
    `💰 الإجمالي: ${formatIQD(order.pricing.totalIqd)}`,
    `🎟️ القسيمة: ${order.voucherCode}`,
    `⏰ وقت الوصول المتوقع: ${order.estimatedArrival}`
  );
  return lines.join('\n');
}

export function buildCustomerStatusWhatsAppText(
  order: Order,
  agencyName = 'وكالة بلوكرانا للعطور'
): string {
  return [
    `مرحباً ${order.fullName} 🌸`,
    `تحديث طلبك رقم (${order.orderNumber}) من ${agencyName}:`,
    `📌 الحالة الحالية: ${order.status}`,
    `⏰ وقت الوصول المتوقع: ${order.estimatedArrival}`,
    `💬 ملاحظة الوكالة: ${order.statusMessage}`,
    `💰 الإجمالي عند الاستلام: ${formatIQD(order.pricing.totalIqd)}`,
    `شكراً لثقتك بنا 🤍`,
  ].join('\n');
}

export function formatArabicDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ar-IQ', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
