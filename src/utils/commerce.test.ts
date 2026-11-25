import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLAUGRANA_DEFAULT_SIZE_PRICES,
  buildCustomerStatusWhatsAppText,
  buildOwnerOrderAlertMessage,
  buildWhatsAppUrl,
  calculateCartSummary,
  compareProductsByCode,
  formatIQD,
  getOrderProgressStepIndex,
  getProductSizeOptions,
  isPromoCodeValidNow,
  isQualifyingPerfumeCategory,
  matchesNoteFamily,
  normalizePhoneNumber,
  normalizePromoCode,
  resolveProductUnitPrice,
  sanitizeHref,
  sanitizeImageInput,
  validateCheckoutInput,
  validateCustomRequestInput,
  type Order,
  type Product,
} from './commerce';

const makePerfume = (
  id: string,
  priceIqd: number,
  category: Product['category'] = 'blaugrana',
  overrides: Partial<Product> = {}
): Product => ({
  id,
  code: `#${id}`,
  name: `عطر ${id}`,
  brand: category === 'other_brands' ? 'Dior' : 'بلوكرانا',
  category,
  priceIqd,
  size: '100 مل',
  notes: 'عود وعنبر',
  longevity: '24 ساعة',
  sillage: 'قوي',
  description: 'عطر فاخر',
  imageUrl: '/src/assets/images/perfume_signature_oud_1795208161900.jpg',
  includesFreeTester: category === 'blaugrana' || category === 'other_brands',
  inStock: true,
  ...overrides,
});

test('formatIQD formats numbers cleanly in IQD', () => {
  assert.equal(formatIQD(20000), '20,000 د.ع');
  assert.equal(formatIQD(0), '0 د.ع');
});

test('free delivery activates at 20,000 IQD and above', () => {
  const below = calculateCartSummary([{ product: makePerfume('1', 15000), quantity: 1 }]);
  assert.equal(below.qualifiesForFreeDelivery, false);
  assert.equal(below.deliveryFeeIqd, 5000);
  assert.equal(below.amountToFreeDeliveryIqd, 5000);
  assert.equal(below.totalIqd, 20000);

  const exact = calculateCartSummary([{ product: makePerfume('2', 20000), quantity: 1 }]);
  assert.equal(exact.qualifiesForFreeDelivery, true);
  assert.equal(exact.deliveryFeeIqd, 0);
  assert.equal(exact.amountToFreeDeliveryIqd, 0);
  assert.equal(exact.totalIqd, 20000);
});

test('4+1 loyalty coupon grants 5th perfume free on lowest-priced qualifying item', () => {
  const summary4 = calculateCartSummary([
    { product: makePerfume('1', 25000), quantity: 4 },
  ]);
  assert.equal(summary4.freePerfumeUnitsEarned, 0);
  assert.equal(summary4.loyaltyDiscountIqd, 0);
  assert.equal(summary4.stampsAfter, 4);
  assert.equal(summary4.stampsNeededForNextFree, 1);
  assert.equal(summary4.freeTestersCount, 4);

  const summary5 = calculateCartSummary([
    { product: makePerfume('1', 25000), quantity: 4 },
    { product: makePerfume('2', 18000, 'other_brands'), quantity: 1 },
  ]);
  assert.equal(summary5.freePerfumeUnitsEarned, 1);
  assert.equal(summary5.loyaltyDiscountIqd, 18000);
  assert.equal(summary5.subtotalAfterDiscountIqd, 100000);
  assert.equal(summary5.stampsAfter, 0);
  assert.equal(summary5.freeTestersCount, 5);
});

test('prior qualifying perfumes carry over across orders for the 5th free perfume', () => {
  const summary = calculateCartSummary(
    [{ product: makePerfume('1', 22000), quantity: 1 }],
    4
  );
  assert.equal(summary.freePerfumeUnitsEarned, 1);
  assert.equal(summary.loyaltyDiscountIqd, 22000);
  assert.equal(summary.subtotalAfterDiscountIqd, 0);
});

test('non-perfume items (body mist / deodorant) do not count toward 4+1 perfume stamps', () => {
  const mist = makePerfume('m1', 10000, 'body_mist');
  const summary = calculateCartSummary([{ product: mist, quantity: 5 }]);
  assert.equal(summary.qualifyingPerfumeUnits, 0);
  assert.equal(summary.freePerfumeUnitsEarned, 0);
  assert.equal(summary.loyaltyDiscountIqd, 0);
  assert.equal(summary.freeTestersCount, 0);
});

test('compareProductsByCode orders M01..M65 strictly in ascending numeric sequence', () => {
  const p65 = makePerfume('65', 20000, 'blaugrana', { code: 'M65' });
  const p02 = makePerfume('02', 20000, 'blaugrana', { code: 'M02' });
  const p10 = makePerfume('10', 20000, 'blaugrana', { code: 'M10' });
  const other = makePerfume('201', 45000, 'other_brands', { code: '201' });

  const sorted = [p65, other, p10, p02].sort(compareProductsByCode);
  assert.deepEqual(
    sorted.map((p) => p.code),
    ['M02', 'M10', 'M65', '201']
  );
});

test('matchesNoteFamily filters across topNotes, heartNotes, and baseNotes', () => {
  const oud = makePerfume('m04', 25000, 'blaugrana', {
    code: 'M04',
    notes: 'عود وزعفران',
    topNotes: 'كسر العود المغربي، الزعفران الأصلي',
    heartNotes: 'دهن العود الهندي',
    baseNotes: 'المسك، العنبر الأصلي',
  });
  assert.equal(matchesNoteFamily(oud, 'oud_incense'), true);
  assert.equal(matchesNoteFamily(oud, 'amber_vanilla'), true);
  assert.equal(matchesNoteFamily(oud, 'citrus_fresh'), false);
});

test('sanitizeHref blocks javascript and data URLs', () => {
  assert.equal(sanitizeHref('https://instagram.com/blaugrana.perfumes'), 'https://instagram.com/blaugrana.perfumes');
  assert.equal(sanitizeHref('javascript:alert(1)'), '#');
  assert.equal(sanitizeHref('data:text/html,hi'), '#');
});

test('sanitizeImageInput allows local assets, https/http, protocol-relative, bare domains, and raster base64 images while blocking unsafe inputs', () => {
  const fb = '/fallback.jpg';
  assert.equal(sanitizeImageInput('/assets/aistudio/IMG_0561_479e513f.JPG', fb), '/assets/aistudio/IMG_0561_479e513f.JPG');
  assert.equal(sanitizeImageInput('https://cdn.example.com/perfume.jpg', fb), 'https://cdn.example.com/perfume.jpg');
  assert.equal(sanitizeImageInput('//cdn.example.com/perfume.webp', fb), 'https://cdn.example.com/perfume.webp');
  assert.equal(sanitizeImageInput('cdn.example.com/img/a.png', fb), 'https://cdn.example.com/img/a.png');
  assert.equal(sanitizeImageInput('data:image/jpeg;base64,/9j/4AAQ', fb), 'data:image/jpeg;base64,/9j/4AAQ');
  assert.equal(sanitizeImageInput('javascript:alert(1)', fb), fb);
  assert.equal(sanitizeImageInput('data:text/html,<script>alert(1)</script>', fb), fb);
  assert.equal(sanitizeImageInput('/assets/aistudio/../secret.jpg', fb), fb);
});

test('normalizePhoneNumber normalizes Iraqi numbers', () => {
  assert.equal(normalizePhoneNumber('+9647745306712'), '07745306712');
  assert.equal(normalizePhoneNumber('0774 530 6712'), '07745306712');
});

test('validators catch missing required fields and pass valid input', () => {
  const badCheckout = validateCheckoutInput({
    fullName: 'أ',
    exactLocation: 'د',
    birthDate: '',
    phone: '123',
    itemsCount: 0,
  });
  assert.equal(badCheckout.valid, false);
  assert.ok(badCheckout.errors.fullName);
  assert.ok(badCheckout.errors.exactLocation);
  assert.ok(badCheckout.errors.birthDate);
  assert.ok(badCheckout.errors.phone);
  assert.ok(badCheckout.errors.items);

  const goodCheckout = validateCheckoutInput({
    fullName: 'عمر أحمد علي',
    exactLocation: 'ديالى - بعقوبة - التحرير - قرب جامع الحسينية',
    birthDate: '1998-05-12',
    phone: '07745306712',
    itemsCount: 2,
  });
  assert.equal(goodCheckout.valid, true);

  const goodCustom = validateCustomRequestInput({
    perfumeName: 'بلو شانيل',
    expectedPriceIqd: 40000,
    size: '100 مل',
    desiredDate: '2026-12-01',
    customerName: 'سارة محمد',
    customerPhone: '07712345678',
  });
  assert.equal(goodCustom.valid, true);
});

test('order tracking progress index and WhatsApp notification builders work properly', () => {
  assert.equal(getOrderProgressStepIndex('تم الاستلام'), 0);
  assert.equal(getOrderProgressStepIndex('قيد المراجعة'), 0);
  assert.equal(getOrderProgressStepIndex('تم التجهيز'), 1);
  assert.equal(getOrderProgressStepIndex('قيد التوصيل'), 2);
  assert.equal(getOrderProgressStepIndex('تم التسليم'), 3);

  const url = buildWhatsAppUrl('07745306712', 'مرحبا');
  assert.ok(url.startsWith('https://wa.me/9647745306712?text='));

  const sampleOrder: Order = {
    id: 'ord-1',
    orderNumber: 'BG-1001',
    createdAt: '2026-11-20T13:00:00.000Z',
    fullName: 'علي حسن',
    exactLocation: 'بعقوبة - التحرير',
    birthDate: '1999-01-01',
    phone: '07745306712',
    items: [
      {
        productId: 'bg-m01',
        code: 'M01',
        name: 'أرماني بريف الأخضر',
        brand: 'بلوكرانا',
        category: 'blaugrana',
        priceIqd: 25000,
        quantity: 1,
        includesFreeTester: true,
      },
    ],
    pricing: calculateCartSummary([{ product: makePerfume('m01', 25000), quantity: 1 }]),
    voucherCode: 'BG-VIP-6712',
    status: 'تم الاستلام',
    estimatedArrival: 'اليوم الساعة 5:00 عصراً',
    statusMessage: 'تم استلام طلبك وجاري تجهيزه',
    statusHistory: [{ status: 'تم الاستلام', timestamp: '2026-11-20T13:00:00.000Z' }],
  };

  const ownerMsg = buildOwnerOrderAlertMessage(sampleOrder);
  assert.ok(ownerMsg.includes('BG-1001'));
  assert.ok(ownerMsg.includes('علي حسن'));
  assert.ok(ownerMsg.includes('M01'));

  const customerMsg = buildCustomerStatusWhatsAppText(sampleOrder);
  assert.ok(customerMsg.includes('اليوم الساعة 5:00 عصراً'));
  assert.ok(customerMsg.includes('تم الاستلام'));
});

test('multi-size Blaugrana pricing (30ml=10k, 50ml=18k, 100ml=30k) and promo codes calculate accurately', () => {
  const bgPerfume = makePerfume('m01', 30000, 'blaugrana', {
    size: '100 مل',
    sizePrices: { ...BLAUGRANA_DEFAULT_SIZE_PRICES },
  });

  const opts = getProductSizeOptions(bgPerfume);
  assert.deepEqual(
    opts.map((o) => [o.size, o.priceIqd]),
    [
      ['30 مل', 10000],
      ['50 مل', 18000],
      ['100 مل', 30000],
    ]
  );

  assert.equal(resolveProductUnitPrice(bgPerfume, '30 مل').priceIqd, 10000);
  assert.equal(resolveProductUnitPrice(bgPerfume, '50 مل').priceIqd, 18000);
  assert.equal(resolveProductUnitPrice(bgPerfume, '100 مل').priceIqd, 30000);

  assert.equal(normalizePromoCode('  omar 10 '), 'OMAR10');

  const summaryPercent = calculateCartSummary(
    [
      { product: bgPerfume, quantity: 1, selectedSize: '30 مل' },
      { product: bgPerfume, quantity: 1, selectedSize: '100 مل' },
    ],
    0,
    {
      code: 'OMAR10',
      ownerName: 'عمر',
      discountType: 'percent',
      discountValue: 10,
    }
  );
  assert.equal(summaryPercent.rawSubtotalIqd, 40000);
  assert.equal(summaryPercent.promoDiscountIqd, 4000);
  assert.equal(summaryPercent.subtotalAfterDiscountIqd, 36000);
  assert.equal(summaryPercent.promoCode, 'OMAR10');
  assert.equal(summaryPercent.promoOwnerName, 'عمر');
  assert.equal(summaryPercent.qualifiesForFreeDelivery, true);
  assert.equal(summaryPercent.totalIqd, 36000);

  const summaryFixed = calculateCartSummary(
    [{ product: bgPerfume, quantity: 1, selectedSize: '50 مل' }],
    0,
    {
      code: 'ALI3000',
      ownerName: 'علي',
      discountType: 'fixed',
      discountValue: 3000,
    }
  );
  assert.equal(summaryFixed.rawSubtotalIqd, 18000);
  assert.equal(summaryFixed.promoDiscountIqd, 3000);
  assert.equal(summaryFixed.subtotalAfterDiscountIqd, 15000);
  assert.equal(summaryFixed.qualifiesForFreeDelivery, false);
  assert.equal(summaryFixed.totalIqd, 20000);
});

test('hair_care does not count toward 4+1 perfume stamps and sorts cleanly after M01..M65', () => {
  assert.equal(isQualifyingPerfumeCategory('hair_care'), false);
  const shampoo = makePerfume('hr-01', 15000, 'hair_care', {
    code: 'HR-01',
    includesFreeTester: false,
  });
  const summary = calculateCartSummary([{ product: shampoo, quantity: 5 }]);
  assert.equal(summary.qualifyingPerfumeUnits, 0);
  assert.equal(summary.freePerfumeUnitsEarned, 0);
  assert.equal(summary.freeTestersCount, 0);

  const m65 = makePerfume('bg-m65', 30000, 'blaugrana', { code: 'M65' });
  const m02 = makePerfume('bg-m02', 30000, 'blaugrana', { code: 'M02' });
  const eyfM1 = makePerfume('new-eyfel-m1', 18000, 'other_brands', { code: 'EYF-M1' });
  const hawas = makePerfume('new-hawas-1', 45000, 'other_brands', { code: 'HWS-01' });

  const sorted = [shampoo, eyfM1, m65, hawas, m02].sort(compareProductsByCode);
  assert.deepEqual(
    sorted.map((p) => p.code),
    ['M02', 'M65', 'EYF-M1', 'HR-01', 'HWS-01']
  );
});

test('isPromoCodeValidNow handles unlimited, active with remaining days, expired, and paused promos', () => {
  const now = Date.parse('2026-11-23T12:00:00.000Z');
  const unlimited = isPromoCodeValidNow({ active: true, expiresAt: null }, now);
  assert.deepEqual(unlimited, { valid: true, expired: false, remainingDays: null });

  const sevenDaysMs = 7 * 86_400_000;
  const futureValid = isPromoCodeValidNow(
    { active: true, expiresAt: new Date(now + sevenDaysMs).toISOString() },
    now
  );
  assert.deepEqual(futureValid, { valid: true, expired: false, remainingDays: 7 });

  const expired = isPromoCodeValidNow(
    { active: true, expiresAt: new Date(now - 60_000).toISOString() },
    now
  );
  assert.deepEqual(expired, { valid: false, expired: true, remainingDays: 0 });

  const paused = isPromoCodeValidNow(
    { active: false, expiresAt: new Date(now + sevenDaysMs).toISOString() },
    now
  );
  assert.deepEqual(paused, { valid: false, expired: false, remainingDays: 7 });
});
