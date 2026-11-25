import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';

const ROOT = process.cwd();
const PROJECT_ID = 'glass-voltage-60z9n';
const RULES_CONTENT = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const BLUEPRINT = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'firebase-blueprint.json'), 'utf8')
) as { firestore: Record<string, unknown> };

let testEnv: RulesTestEnvironment;

const VALID_TOKEN_HEX = crypto.randomBytes(32).toString('hex');
const VALID_LOYALTY_HEX = crypto.randomBytes(32).toString('hex');
const VALID_CHECKSUM_HEX = crypto.createHash('sha256').update('backup-check').digest('hex');

const VALID_PRODUCT = {
  id: 'bg-m01',
  code: 'M01',
  name: 'بلوكرانا عود',
  brand: 'بلوكرانا',
  category: 'blaugrana',
  priceIqd: 30000,
  size: '100 مل',
  notes: 'عود، عنبر، مسك',
  longevity: '24 ساعة',
  sillage: 'فوحان ممتاز',
  description: 'عطر فاخر ثابت',
  imageUrl: 'https://i.postimg.cc/example/m01.jpg',
  includesFreeTester: true,
  inStock: true,
};

const VALID_CATALOG_META = {
  version: 'v1.0.0',
  productCount: 229,
  chunkIds: ['chunk_0', 'chunk_1'],
  storeInfo: {
    agencyName: 'وكالة بلوكرانا للعطور',
    locationText: 'العراق - ديالى - بعقوبة',
    city: 'ديالى - بعقوبة',
    freeDeliveryThresholdIqd: 20000,
    standardDeliveryFeeIqd: 5000,
    guaranteeTitle: 'ضمان الثبات الذهبي',
    guaranteeText: 'ضمان حقيقي للثبات والفوحان مع تيستر مجاني.',
  },
  socialLinks: [{ id: 'soc-1', platform: 'واتساب', label: 'واتساب', handle: '07745306712', url: 'https://wa.me/9647745306712' }],
  updatedAt: '2026-11-23T21:00:00Z',
};

const VALID_PROMO = {
  id: 'pr-1',
  code: 'VIP2026',
  ownerName: 'أحمد العزاوي',
  discountType: 'percent',
  discountValue: 15,
  active: true,
  timesUsed: 0,
  createdAt: '2026-11-23T21:00:00Z',
};

const VALID_ORDER = {
  id: 'ord-1001',
  orderNumber: 'BG-1001',
  trackingToken: VALID_TOKEN_HEX,
  createdAt: '2026-11-23T21:00:00Z',
  fullName: 'علي حسن',
  exactLocation: 'بغداد - المنصور - شارع 14 رمضان',
  birthDate: '1998-05-01',
  phone: '07745306712',
  items: [{ productId: 'bg-m01', code: 'M01', name: 'بلوكرانا عود', priceIqd: 30000, quantity: 1 }],
  pricing: {
    totalItemsCount: 1,
    qualifyingPerfumeUnits: 1,
    freeTestersCount: 1,
    freePerfumeUnitsEarned: 0,
    loyaltyDiscountIqd: 0,
    promoDiscountIqd: 0,
    rawSubtotalIqd: 30000,
    subtotalAfterDiscountIqd: 30000,
    deliveryFeeIqd: 0,
    qualifiesForFreeDelivery: true,
    amountToFreeDeliveryIqd: 0,
    totalIqd: 30000,
    priorPerfumeUnits: 0,
    stampsBefore: 0,
    stampsAfter: 1,
    stampsNeededForNextFree: 4,
  },
  voucherCode: 'BG-VIP-6712',
  status: 'تم الاستلام',
  estimatedArrival: 'خلال 24 ساعة',
  statusMessage: 'تم استلام طلبك بنجاح',
  statusHistory: [{ status: 'تم الاستلام', timestamp: '2026-11-23T21:00:00Z' }],
};

const VALID_TRACKING = {
  orderId: 'ord-1001',
  orderNumber: 'BG-1001',
  createdAt: '2026-11-23T21:00:00Z',
  itemsSummary: '#M01 بلوكرانا عود × 1',
  totalIqd: 30000,
  voucherCode: 'BG-VIP-6712',
  status: 'تم الاستلام',
  estimatedArrival: 'خلال 24 ساعة',
  statusMessage: 'تم استلام طلبك بنجاح',
  statusHistory: [{ status: 'تم الاستلام', timestamp: '2026-11-23T21:00:00Z' }],
};

const VALID_CUSTOM_REQ = {
  id: 'creq-1',
  createdAt: '2026-11-23T21:00:00Z',
  perfumeName: 'كريد أفينتوس',
  expectedPriceIqd: 45000,
  size: '100 مل',
  desiredDate: '2026-11-30',
  customerName: 'سارة محمد',
  customerPhone: '07701234567',
  notes: 'تغليف هدية',
  status: 'قيد البحث',
};

const VALID_LOYALTY = {
  loyaltyKey: VALID_LOYALTY_HEX,
  totalQualifyingPerfumes: 3,
  stamps: 3,
  stampsRemainingForFree: 2,
  freePerfumesRedeemed: 0,
  voucherCode: 'BG-VIP-6712',
  ordersCount: 2,
  updatedAt: '2026-11-23T21:00:00Z',
};

const VALID_NOTIFICATION = {
  id: 'notif-1',
  createdAt: '2026-11-23T21:00:00Z',
  type: 'new_order',
  orderId: 'ord-1001',
  orderNumber: 'BG-1001',
  customerName: 'علي حسن',
  customerPhone: '07745306712',
  exactLocation: 'بغداد - المنصور - شارع 14 رمضان',
  totalIqd: 30000,
  itemsSummary: '#M01 بلوكرانا عود × 1',
  message: 'طلب جديد رقم BG-1001',
  read: false,
};

function visitorDb() {
  return testEnv.unauthenticatedContext().firestore();
}

function attackerDb() {
  return testEnv
    .authenticatedContext('attacker-uid', {
      email: 'attacker@gmail.com',
      email_verified: true,
    })
    .firestore();
}

function spoofedUnverifiedAdminDb() {
  return testEnv
    .authenticatedContext('spoof-uid', {
      email: 'wwwomara6@gmail.com',
      email_verified: false,
    })
    .firestore();
}

function ownerAdminDb() {
  return testEnv
    .authenticatedContext('owner-uid', {
      email: 'wwwomara6@gmail.com',
      email_verified: true,
    })
    .firestore();
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: RULES_CONTENT,
      host: '127.0.0.1',
      port: 8085,
    },
  });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'test', 'connection'), { ok: true });
    await setDoc(doc(db, 'admins', 'owner-uid'), {
      email: 'wwwomara6@gmail.com',
      role: 'owner',
      updatedAt: '2026-11-23T21:00:00Z',
    });
    await setDoc(doc(db, 'catalog_meta', 'public'), VALID_CATALOG_META);
    await setDoc(doc(db, 'catalog_chunks', 'chunk_0'), {
      chunkIndex: 0,
      version: 'v1.0.0',
      items: [VALID_PRODUCT],
      updatedAt: '2026-11-23T21:00:00Z',
    });
    await setDoc(doc(db, 'products', 'bg-m01'), VALID_PRODUCT);
    await setDoc(doc(db, 'promoCodes', 'VIP2026'), VALID_PROMO);
    await setDoc(doc(db, 'orders', 'ord-1001'), VALID_ORDER);
    await setDoc(doc(db, 'orderTrackings', VALID_TOKEN_HEX), VALID_TRACKING);
    await setDoc(doc(db, 'customRequests', 'creq-1'), VALID_CUSTOM_REQ);
    await setDoc(doc(db, 'loyaltyLookups', VALID_LOYALTY_HEX), VALID_LOYALTY);
    await setDoc(doc(db, 'notifications', 'notif-1'), VALID_NOTIFICATION);
    await setDoc(doc(db, 'counters', 'orders'), {
      nextSequence: 1002,
      updatedAt: '2026-11-23T21:00:00Z',
    });
  });
});

after(async () => {
  await testEnv.cleanup();
});

test('1. Schema completeness & zero leaked secrets in rules/config', () => {
  for (const collectionPath of Object.keys(BLUEPRINT.firestore)) {
    assert.ok(RULES_CONTENT.includes(`match ${collectionPath} {`), `Missing match ${collectionPath}`);
  }
  const firebaseLib = fs.readFileSync(path.join(ROOT, 'src/lib/firebase.ts'), 'utf8');
  for (const secretKey of ['TELEGRAM_BOT_TOKEN', 'ADMIN_PASSCODE', 'botToken', 'sessionSecret']) {
    assert.ok(!firebaseLib.includes(secretKey), `Unexpected secret pattern ${secretKey}`);
    assert.ok(!RULES_CONTENT.includes(secretKey), `Unexpected secret pattern ${secretKey}`);
  }
});

test('2. /test/connection & /admins/{uid} permissions (Emulator)', async () => {
  await assertSucceeds(getDoc(doc(visitorDb(), 'test', 'connection')));
  await assertFails(setDoc(doc(visitorDb(), 'test', 'connection'), { ok: false }));
  await assertFails(setDoc(doc(ownerAdminDb(), 'test', 'connection'), { ok: false }));

  await assertFails(getDoc(doc(visitorDb(), 'admins', 'owner-uid')));
  await assertFails(getDoc(doc(attackerDb(), 'admins', 'owner-uid')));
  await assertFails(getDoc(doc(spoofedUnverifiedAdminDb(), 'admins', 'owner-uid')));
  await assertSucceeds(getDoc(doc(ownerAdminDb(), 'admins', 'owner-uid')));
  await assertFails(
    setDoc(doc(ownerAdminDb(), 'admins', 'new-uid'), {
      email: 'other@gmail.com',
      role: 'owner',
      updatedAt: '2026-11-23T21:00:00Z',
    })
  );
});

test('3. /catalog_meta, /catalog_chunks & /products public read vs admin-only writes & list block', async () => {
  // Visitors can read public storefront cache & single product detail
  await assertSucceeds(getDoc(doc(visitorDb(), 'catalog_meta', 'public')));
  await assertFails(getDoc(doc(visitorDb(), 'catalog_meta', 'private')));
  await assertFails(getDocs(collection(visitorDb(), 'catalog_meta')));
  await assertSucceeds(getDoc(doc(visitorDb(), 'catalog_chunks', 'chunk_0')));
  await assertFails(getDoc(doc(visitorDb(), 'catalog_chunks', 'invalid')));
  await assertFails(getDocs(collection(visitorDb(), 'catalog_chunks')));
  await assertSucceeds(getDoc(doc(visitorDb(), 'products', 'bg-m01')));

  // Visitors and non-admin users CANNOT list 229 products or modify prices/products
  await assertFails(getDocs(collection(visitorDb(), 'products')));
  await assertFails(getDocs(collection(attackerDb(), 'products')));
  await assertFails(updateDoc(doc(visitorDb(), 'products', 'bg-m01'), { priceIqd: 500 }));
  await assertFails(updateDoc(doc(attackerDb(), 'products', 'bg-m01'), { priceIqd: 500 }));
  await assertFails(
    updateDoc(doc(spoofedUnverifiedAdminDb(), 'products', 'bg-m01'), { priceIqd: 500 })
  );

  // Verified Admin can list, update valid product, and fails if shadow field added
  await assertSucceeds(getDocs(collection(ownerAdminDb(), 'products')));
  await assertSucceeds(updateDoc(doc(ownerAdminDb(), 'products', 'bg-m01'), { priceIqd: 32000 }));
  await assertFails(
    setDoc(doc(ownerAdminDb(), 'products', 'bg-m02'), {
      ...VALID_PRODUCT,
      id: 'bg-m02',
      shadowAdminOverride: true,
    })
  );
  await assertSucceeds(setDoc(doc(ownerAdminDb(), 'catalog_meta', 'public'), VALID_CATALOG_META));
});

test('4. /promoCodes ZERO public read/list/write (no ownerName or timesUsed leak)', async () => {
  await assertFails(getDoc(doc(visitorDb(), 'promoCodes', 'VIP2026')));
  await assertFails(getDocs(collection(visitorDb(), 'promoCodes')));
  await assertFails(getDoc(doc(attackerDb(), 'promoCodes', 'VIP2026')));
  await assertFails(getDoc(doc(spoofedUnverifiedAdminDb(), 'promoCodes', 'VIP2026')));
  await assertFails(setDoc(doc(attackerDb(), 'promoCodes', 'HACK99'), { ...VALID_PROMO, code: 'HACK99' }));

  await assertSucceeds(getDoc(doc(ownerAdminDb(), 'promoCodes', 'VIP2026')));
  await assertSucceeds(getDocs(collection(ownerAdminDb(), 'promoCodes')));
  await assertSucceeds(
    setDoc(doc(ownerAdminDb(), 'promoCodes', 'OMAR10'), {
      ...VALID_PROMO,
      id: 'pr-2',
      code: 'OMAR10',
    })
  );
});

test('5. /orders & /orderTrackings ZERO public read/create (prevents browser price tampering & spam)', async () => {
  await assertFails(getDoc(doc(visitorDb(), 'orders', 'ord-1001')));
  await assertFails(getDocs(collection(visitorDb(), 'orders')));
  await assertFails(getDoc(doc(attackerDb(), 'orders', 'ord-1001')));
  await assertFails(getDoc(doc(spoofedUnverifiedAdminDb(), 'orders', 'ord-1001')));
  // Visitor & attacker CANNOT create fake or price-tampered orders directly
  await assertFails(
    setDoc(doc(visitorDb(), 'orders', 'ord-fake'), {
      ...VALID_ORDER,
      id: 'ord-fake',
    })
  );
  await assertFails(
    setDoc(doc(attackerDb(), 'orders', 'ord-fake'), {
      ...VALID_ORDER,
      id: 'ord-fake',
    })
  );

  await assertFails(getDoc(doc(visitorDb(), 'orderTrackings', VALID_TOKEN_HEX)));
  await assertFails(getDocs(collection(attackerDb(), 'orderTrackings')));
  await assertFails(
    setDoc(doc(visitorDb(), 'orderTrackings', VALID_TOKEN_HEX), VALID_TRACKING)
  );

  // Verified Admin succeeds on valid order & tracking mutations
  await assertSucceeds(getDoc(doc(ownerAdminDb(), 'orders', 'ord-1001')));
  await assertSucceeds(
    updateDoc(doc(ownerAdminDb(), 'orders', 'ord-1001'), {
      status: 'تم التجهيز',
      statusMessage: 'تم تجهيز الطلب',
    })
  );
  await assertSucceeds(getDoc(doc(ownerAdminDb(), 'orderTrackings', VALID_TOKEN_HEX)));
});

test('6. /loyaltyLookups & /customRequests ZERO public read/write (no phone-hash guessing or spam)', async () => {
  await assertFails(getDoc(doc(visitorDb(), 'loyaltyLookups', VALID_LOYALTY_HEX)));
  await assertFails(getDocs(collection(visitorDb(), 'loyaltyLookups')));
  await assertFails(getDoc(doc(attackerDb(), 'loyaltyLookups', VALID_LOYALTY_HEX)));
  await assertFails(
    setDoc(doc(visitorDb(), 'loyaltyLookups', VALID_LOYALTY_HEX), {
      ...VALID_LOYALTY,
      totalQualifyingPerfumes: 99,
    })
  );
  await assertSucceeds(getDoc(doc(ownerAdminDb(), 'loyaltyLookups', VALID_LOYALTY_HEX)));
  await assertSucceeds(
    updateDoc(doc(ownerAdminDb(), 'loyaltyLookups', VALID_LOYALTY_HEX), {
      totalQualifyingPerfumes: 4,
      stamps: 4,
      stampsRemainingForFree: 1,
    })
  );

  await assertFails(getDoc(doc(visitorDb(), 'customRequests', 'creq-1')));
  await assertFails(
    setDoc(doc(visitorDb(), 'customRequests', 'creq-spam'), {
      ...VALID_CUSTOM_REQ,
      id: 'creq-spam',
    })
  );
  await assertSucceeds(getDoc(doc(ownerAdminDb(), 'customRequests', 'creq-1')));
});

test('7. /notifications, /counters, /backups & fallback catch-all deny', async () => {
  await assertFails(getDoc(doc(visitorDb(), 'notifications', 'notif-1')));
  await assertFails(getDoc(doc(attackerDb(), 'counters', 'orders')));
  await assertFails(updateDoc(doc(attackerDb(), 'counters', 'orders'), { nextSequence: 9999 }));
  await assertFails(getDocs(collection(attackerDb(), 'backups')));

  await assertSucceeds(updateDoc(doc(ownerAdminDb(), 'notifications', 'notif-1'), { read: true }));
  await assertFails(
    updateDoc(doc(ownerAdminDb(), 'notifications', 'notif-1'), { message: 'tampered' })
  );
  await assertSucceeds(getDoc(doc(ownerAdminDb(), 'counters', 'orders')));
  await assertFails(deleteDoc(doc(ownerAdminDb(), 'counters', 'orders')));

  // Backups: valid admin email succeeds; spoofed createdBy fails
  await assertSucceeds(
    setDoc(doc(ownerAdminDb(), 'backups', 'bk-1'), {
      id: 'bk-1',
      createdAt: '2026-11-23T21:00:00Z',
      createdBy: 'wwwomara6@gmail.com',
      productCount: 229,
      checksumSha256: VALID_CHECKSUM_HEX,
    })
  );
  await assertFails(
    setDoc(doc(ownerAdminDb(), 'backups', 'bk-2'), {
      id: 'bk-2',
      createdAt: '2026-11-23T21:00:00Z',
      createdBy: 'other@gmail.com',
      productCount: 229,
      checksumSha256: VALID_CHECKSUM_HEX,
    })
  );

  // Global catch-all blocks undeclared collections even for admin
  await assertFails(getDoc(doc(ownerAdminDb(), 'undeclaredCollection', 'doc1')));
  await assertFails(setDoc(doc(ownerAdminDb(), 'undeclaredCollection', 'doc1'), { a: 1 }));
});
