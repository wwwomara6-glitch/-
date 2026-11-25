import {
  AlertTriangle,
  ArrowRight,
  Bell,
  BellRing,
  CheckCheck,
  Clock,
  Coins,
  Database,
  ImagePlus,
  Lock,
  LogOut,
  MessageCircle,
  Package,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  Share2,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AUTHORIZED_ADMIN_EMAIL,
  auth,
  isAuthorizedAdminUser,
  subscribeAdminAuth,
} from '../lib/firebase';
import { loadFirestoreCatalog } from '../lib/firebaseCatalog';
import {
  commitCatalogSyncToFirestore,
  generateValidProductId,
  sanitizeAndValidateProductForFirestore,
  type CatalogMutationInput,
} from '../lib/firestoreCatalogSync';
import {
  BLAUGRANA_DEFAULT_SIZE_PRICES,
  CATEGORY_LABELS,
  DEFAULT_STATUS_MESSAGES,
  buildCustomerStatusWhatsAppText,
  buildWhatsAppUrl,
  compareProductsByCode,
  formatArabicDateTime,
  formatIQD,
  getProductSizeOptions,
  isPromoCodeValidNow,
  sanitizeHref,
  type AdminNotification,
  type CustomPerfumeRequest,
  type CustomRequestStatus,
  type Order,
  type OrderStatus,
  type Product,
  type ProductCategory,
  type PromoCode,
  type PromoDiscountType,
  type SocialLink,
  type StoreInfo,
} from '../utils/commerce';
import { apiUrl, isMaintenanceResponse, warmApiServer } from '../lib/apiClient';
import { type BackupRestoreResult } from '../lib/firestoreBackup';
import { FirestoreBackupPanel } from './FirestoreBackupPanel';
import { FirestoreMigrationPanel } from './FirestoreMigrationPanel';
import { SafeImage } from './SafeImage';

export interface AdminAuthState {
  configured: boolean;
  mode: 'env' | 'claimed' | 'unclaimed';
}

interface AdminDashboardProps {
  authState: AdminAuthState;
  onAuthStateChange: (state: AdminAuthState) => void;
  onExitAdmin: () => void;
  onCatalogMutated: () => Promise<void>;
  storeInfo?: StoreInfo;
}

const DEFAULT_STORE_INFO_FALLBACK: StoreInfo = {
  agencyName: 'وكالة بلوكرانا للعطور',
  locationText: 'العراق - ديالى - بعقوبة - التحرير - شارع الحسينية',
  city: 'ديالى - بعقوبة',
  freeDeliveryThresholdIqd: 20000,
  standardDeliveryFeeIqd: 5000,
  guaranteeTitle: 'ضمان الثبات والفوحان الذهبي + تيستر مجاني مع كل عطر',
  guaranteeText:
    'كل عطر تطلبه من وكالة بلوكرانا يصلك مع عينة تيستر مجانية للتجربة قبل فتح العبوة الأصلية، مع ضمان حقيقي للثبات والفوحان.',
};

type AdminTab =
  | 'orders'
  | 'notifications'
  | 'custom_requests'
  | 'products'
  | 'promo_codes'
  | 'social';

interface OrderEditDraft {
  status: OrderStatus;
  estimatedArrival: string;
  statusMessage: string;
}

interface TelegramStatus {
  configured: boolean;
  chatIdMasked: string;
}

const ARRIVAL_PRESETS = [
  'خلال 24 ساعة',
  'اليوم عصراً',
  'اليوم مساءً',
  'غداً صباحاً',
];

function playNotificationChime() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const tones = [587.33, 880];
    tones.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.12);
      gain.gain.setValueAtTime(0.001, now + idx * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.12 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.12);
      osc.stop(now + idx * 0.12 + 0.24);
    });
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 600);
  } catch {
    // Ignore audio context restrictions before user gesture
  }
}

const IMAGE_PRESETS: Array<{ label: string; url: string }> = [
  {
    label: 'عطر بلوكرانا الكلاسيكي (كحلي وذهبي)',
    url: '/src/assets/images/perfume_signature_oud_1795208161900.jpg',
  },
  {
    label: 'عطر بلوكرانا العنابي (ياقوتي)',
    url: '/src/assets/images/perfume_crimson_rose_1795208162606.jpg',
  },
  {
    label: 'معطر جسم ومزيل عرق',
    url: '/src/assets/images/product_body_mist_1795208162237.jpg',
  },
  {
    label: 'مجموعة تيسترات التجربة',
    url: '/src/assets/images/product_tester_kit_1795208162880.jpg',
  },
  {
    label: 'شامبو هير وعناية بالشعر',
    url: '/assets/aistudio/hair_shampoo_studio.jpg',
  },
];

const ADMIN_TOKEN_STORAGE_KEY = 'bg_admin_session_token';
const ADMIN_DRAFT_STORAGE_KEY = 'bg_admin_product_draft_v1';
const ADMIN_PENDING_EDITS_KEY = 'bg_admin_pending_edits_v1';
const OWNER_CATALOG_SYNC_KEY = 'bg_owner_catalog_sync_v1';
const OWNER_STATE_SYNC_KEY = 'bg_owner_state_sync_v1';

interface PendingProductEdit {
  imageUrl?: string;
  priceIqd?: number;
  sizePrices?: Record<string, number>;
}

interface OwnerCatalogSyncState {
  addedProducts: Product[];
  updatedProducts: Product[];
  deletedIds: string[];
}

function readStorageJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeStorageJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota errors cleanly
  }
}

function loadOwnerCatalogSync(): OwnerCatalogSyncState {
  const parsed = readStorageJson<Partial<OwnerCatalogSyncState>>(
    OWNER_CATALOG_SYNC_KEY,
    {}
  );
  return {
    addedProducts: Array.isArray(parsed.addedProducts) ? parsed.addedProducts : [],
    updatedProducts: Array.isArray(parsed.updatedProducts)
      ? parsed.updatedProducts
      : [],
    deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [],
  };
}

function recordOwnerAddedProducts(newProducts: Product[]) {
  if (newProducts.length === 0) return;
  const current = loadOwnerCatalogSync();
  const addedMap = new Map(current.addedProducts.map((p) => [p.id, p]));
  const deletedSet = new Set(current.deletedIds);
  for (const prod of newProducts) {
    deletedSet.delete(prod.id);
    addedMap.set(prod.id, prod);
  }
  writeStorageJson(OWNER_CATALOG_SYNC_KEY, {
    addedProducts: Array.from(addedMap.values()),
    updatedProducts: current.updatedProducts,
    deletedIds: Array.from(deletedSet),
  });
}

function recordOwnerUpdatedProducts(updated: Product[]) {
  if (updated.length === 0) return;
  const current = loadOwnerCatalogSync();
  const addedMap = new Map(current.addedProducts.map((p) => [p.id, p]));
  const updatedMap = new Map(current.updatedProducts.map((p) => [p.id, p]));
  const deletedSet = new Set(current.deletedIds);
  for (const prod of updated) {
    deletedSet.delete(prod.id);
    if (addedMap.has(prod.id)) {
      addedMap.set(prod.id, prod);
    } else {
      updatedMap.set(prod.id, prod);
    }
  }
  writeStorageJson(OWNER_CATALOG_SYNC_KEY, {
    addedProducts: Array.from(addedMap.values()),
    updatedProducts: Array.from(updatedMap.values()),
    deletedIds: Array.from(deletedSet),
  });
}

function recordOwnerDeletedProduct(productId: string) {
  const current = loadOwnerCatalogSync();
  const deletedSet = new Set(current.deletedIds);
  deletedSet.add(productId);
  writeStorageJson(OWNER_CATALOG_SYNC_KEY, {
    addedProducts: current.addedProducts.filter((p) => p.id !== productId),
    updatedProducts: current.updatedProducts.filter((p) => p.id !== productId),
    deletedIds: Array.from(deletedSet),
  });
}

interface OwnerStateSync {
  promoCodes: PromoCode[];
  deletedPromoIds: string[];
  socialLinks: SocialLink[];
}

function loadOwnerStateSync(): OwnerStateSync {
  const parsed = readStorageJson<Partial<OwnerStateSync>>(
    OWNER_STATE_SYNC_KEY,
    {}
  );
  return {
    promoCodes: Array.isArray(parsed.promoCodes) ? parsed.promoCodes : [],
    deletedPromoIds: Array.isArray(parsed.deletedPromoIds)
      ? parsed.deletedPromoIds
      : [],
    socialLinks: Array.isArray(parsed.socialLinks) ? parsed.socialLinks : [],
  };
}

function writeOwnerStateSync(next: OwnerStateSync) {
  writeStorageJson(OWNER_STATE_SYNC_KEY, next);
}

export function AdminDashboard({
  authState,
  onAuthStateChange,
  onExitAdmin,
  onCatalogMutated,
  storeInfo = DEFAULT_STORE_INFO_FALLBACK,
}: AdminDashboardProps) {
  const [token, setToken] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '';
  });
  const [passcodeInput, setPasscodeInput] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  useEffect(() => {
    void warmApiServer();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (token) {
      window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
  }, [token]);

  const [activeTab, setActiveTab] = useState<AdminTab>('orders');
  const [orders, setOrders] = useState<Order[]>([]);
  const [customRequests, setCustomRequests] = useState<CustomPerfumeRequest[]>(
    []
  );
  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [promoCodes, setPromoCodes] = useState<PromoCode[]>([]);
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>([]);
  const [loyaltyCount, setLoyaltyCount] = useState(0);
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus>({
    configured: false,
    chatIdMasked: '',
  });
  const [statusMessage, setStatusMessage] = useState('');
  const [statusTone, setStatusTone] = useState<'success' | 'warning' | 'error'>(
    'success'
  );
  const [firestoreOwnerUser, setFirestoreOwnerUser] = useState<User | null>(
    () => auth.currentUser
  );
  const [isFirestoreOwnerVerified, setIsFirestoreOwnerVerified] =
    useState<boolean>(() => isAuthorizedAdminUser(auth.currentUser));

  useEffect(() => {
    const unsubscribe = subscribeAdminAuth(({ user, isAdmin }) => {
      setFirestoreOwnerUser(user);
      setIsFirestoreOwnerVerified(isAdmin);
    });
    return () => unsubscribe();
  }, []);

  const setBannerStatus = (
    message: string,
    tone: 'success' | 'warning' | 'error' = 'success'
  ) => {
    setStatusTone(tone);
    setStatusMessage(message);
  };

  // Live Alerts & Audio/Browser Notification Preferences
  const [liveStreamConnected, setLiveStreamConnected] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const soundEnabledRef = useRef(true);
  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  const [browserNotifPermission, setBrowserNotifPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'unsupported'
  );

  // Per-Order Editable Tracking Drafts
  const [orderEdits, setOrderEdits] = useState<Record<string, OrderEditDraft>>(
    {}
  );
  const [savingOrderId, setSavingOrderId] = useState<string | null>(null);

  // Telegram Bot Setup Form
  const [tgBotToken, setTgBotToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const [tgBusy, setTgBusy] = useState(false);

  // Product Form State (Add or Edit) with persistent draft for new perfumes
  const productFormRef = useRef<HTMLFormElement | null>(null);
  const initialDraft = readStorageJson<Record<string, string | boolean>>(
    ADMIN_DRAFT_STORAGE_KEY,
    {}
  );
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [pCode, setPCode] = useState(() =>
    typeof initialDraft.pCode === 'string' ? initialDraft.pCode : ''
  );
  const [pName, setPName] = useState(() =>
    typeof initialDraft.pName === 'string' ? initialDraft.pName : ''
  );
  const [pBrand, setPBrand] = useState(() =>
    typeof initialDraft.pBrand === 'string' ? initialDraft.pBrand : 'بلوكرانا'
  );
  const [pCategory, setPCategory] = useState<ProductCategory>(() =>
    typeof initialDraft.pCategory === 'string'
      ? (initialDraft.pCategory as ProductCategory)
      : 'blaugrana'
  );
  const [pPrice, setPPrice] = useState(() =>
    typeof initialDraft.pPrice === 'string' ? initialDraft.pPrice : '30000'
  );
  const [pPrice30, setPPrice30] = useState(() =>
    typeof initialDraft.pPrice30 === 'string' ? initialDraft.pPrice30 : '10000'
  );
  const [pPrice50, setPPrice50] = useState(() =>
    typeof initialDraft.pPrice50 === 'string' ? initialDraft.pPrice50 : '18000'
  );
  const [pPrice100, setPPrice100] = useState(() =>
    typeof initialDraft.pPrice100 === 'string' ? initialDraft.pPrice100 : '30000'
  );
  const [pSize, setPSize] = useState(() =>
    typeof initialDraft.pSize === 'string' ? initialDraft.pSize : '100 مل'
  );
  const [pTopNotes, setPTopNotes] = useState(() =>
    typeof initialDraft.pTopNotes === 'string' ? initialDraft.pTopNotes : ''
  );
  const [pHeartNotes, setPHeartNotes] = useState(() =>
    typeof initialDraft.pHeartNotes === 'string' ? initialDraft.pHeartNotes : ''
  );
  const [pBaseNotes, setPBaseNotes] = useState(() =>
    typeof initialDraft.pBaseNotes === 'string' ? initialDraft.pBaseNotes : ''
  );
  const [pNotes, setPNotes] = useState(() =>
    typeof initialDraft.pNotes === 'string' ? initialDraft.pNotes : ''
  );
  const [pLongevity, setPLongevity] = useState(() =>
    typeof initialDraft.pLongevity === 'string' ? initialDraft.pLongevity : '24 ساعة'
  );
  const [pSillage, setPSillage] = useState(() =>
    typeof initialDraft.pSillage === 'string' ? initialDraft.pSillage : 'فوحان قوي'
  );
  const [pDesc, setPDesc] = useState(() =>
    typeof initialDraft.pDesc === 'string' ? initialDraft.pDesc : ''
  );
  const [pImageUrl, setPImageUrl] = useState(() =>
    typeof initialDraft.pImageUrl === 'string'
      ? initialDraft.pImageUrl
      : IMAGE_PRESETS[0].url
  );
  const [pFreeTester, setPFreeTester] = useState(() =>
    typeof initialDraft.pFreeTester === 'boolean' ? initialDraft.pFreeTester : true
  );
  const [pInStock, setPInStock] = useState(() =>
    typeof initialDraft.pInStock === 'boolean' ? initialDraft.pInStock : true
  );
  const [uploadingFormImage, setUploadingFormImage] = useState(false);
  const [savingProduct, setSavingProduct] = useState(false);

  useEffect(() => {
    if (editingProductId) return;
    writeStorageJson(ADMIN_DRAFT_STORAGE_KEY, {
      pCode,
      pName,
      pBrand,
      pCategory,
      pPrice,
      pPrice30,
      pPrice50,
      pPrice100,
      pSize,
      pTopNotes,
      pHeartNotes,
      pBaseNotes,
      pNotes,
      pLongevity,
      pSillage,
      pDesc,
      pImageUrl,
      pFreeTester,
      pInStock,
    });
  }, [
    editingProductId,
    pCode,
    pName,
    pBrand,
    pCategory,
    pPrice,
    pPrice30,
    pPrice50,
    pPrice100,
    pSize,
    pTopNotes,
    pHeartNotes,
    pBaseNotes,
    pNotes,
    pLongevity,
    pSillage,
    pDesc,
    pImageUrl,
    pFreeTester,
    pInStock,
  ]);

  // Admin Product List Filter + Pending Batch Edits + Inline Editors
  const [pendingProductEdits, setPendingProductEdits] = useState<
    Record<string, PendingProductEdit>
  >(() => readStorageJson<Record<string, PendingProductEdit>>(ADMIN_PENDING_EDITS_KEY, {}));
  const [savingAllChanges, setSavingAllChanges] = useState(false);

  useEffect(() => {
    writeStorageJson(ADMIN_PENDING_EDITS_KEY, pendingProductEdits);
  }, [pendingProductEdits]);

  const [productFilterMode, setProductFilterMode] = useState<
    'all' | 'missing_image'
  >('all');
  const [adminProductSearch, setAdminProductSearch] = useState('');
  const [inlineImageProductId, setInlineImageProductId] = useState<
    string | null
  >(null);
  const [inlineImageUrl, setInlineImageUrl] = useState('');
  const [uploadingInlineImage, setUploadingInlineImage] = useState(false);
  const [inlinePriceProductId, setInlinePriceProductId] = useState<
    string | null
  >(null);
  const [inlineSinglePrice, setInlineSinglePrice] = useState('');
  const [inlinePrice30, setInlinePrice30] = useState('');
  const [inlinePrice50, setInlinePrice50] = useState('');
  const [inlinePrice100, setInlinePrice100] = useState('');

  // Bulk Price Change State
  const [bulkPrice30, setBulkPrice30] = useState('10000');
  const [bulkPrice50, setBulkPrice50] = useState('18000');
  const [bulkPrice100, setBulkPrice100] = useState('30000');
  const [bulkCategory, setBulkCategory] = useState<'all' | ProductCategory>('all');
  const [bulkAdjustType, setBulkAdjustType] = useState<
    'percent' | 'fixed_price' | 'fixed_delta'
  >('fixed_delta');
  const [bulkAdjustValue, setBulkAdjustValue] = useState('');
  const [bulkPriceBusy, setBulkPriceBusy] = useState(false);

  // Bulk Add State
  const [bulkText, setBulkText] = useState('');

  // Promo Code Form State
  const [promoCodeInput, setPromoCodeInput] = useState('');
  const [promoOwnerInput, setPromoOwnerInput] = useState('');
  const [promoDiscountType, setPromoDiscountType] =
    useState<PromoDiscountType>('percent');
  const [promoDiscountValue, setPromoDiscountValue] = useState('10');
  const [promoDurationDays, setPromoDurationDays] = useState('30');
  const [promoBusy, setPromoBusy] = useState(false);
  const [savingSiteChanges, setSavingSiteChanges] = useState(false);

  // Social Link Form State
  const [sPlatform, setSPlatform] = useState('');
  const [sLabel, setSLabel] = useState('');
  const [sHandle, setSHandle] = useState('');
  const [sUrl, setSUrl] = useState('');

  const unreadNotificationsCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  );

  const sortedProducts = useMemo(
    () => [...products].sort(compareProductsByCode),
    [products]
  );

  const missingImageCount = useMemo(
    () => sortedProducts.filter((p) => p.hasCustomImage === false).length,
    [sortedProducts]
  );

  const filteredAdminProducts = useMemo(() => {
    const q = adminProductSearch.trim().toLowerCase();
    return sortedProducts.filter((p) => {
      if (productFilterMode === 'missing_image' && p.hasCustomImage !== false) {
        return false;
      }
      if (!q) return true;
      return (
        p.code.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.notes.toLowerCase().includes(q)
      );
    });
  }, [sortedProducts, productFilterMode, adminProductSearch]);

  const pendingChangesCount = useMemo(
    () => Object.keys(pendingProductEdits).length,
    [pendingProductEdits]
  );

  const hasSyncedOnceRef = useRef(false);

  const fetchDashboard = async (authToken: string) => {
    const [res, firestoreRes] = await Promise.all([
      fetch(apiUrl('/api/admin/dashboard'), {
        headers: { Authorization: `Bearer ${authToken}` },
      }),
      loadFirestoreCatalog({ forceRefresh: true }).catch(() => null),
    ]);
    if (res.status === 401) {
      setToken('');
      return;
    }
    if (!res.ok) return;
    const data = (await res.json()) as {
      orders: Order[];
      customRequests: CustomPerfumeRequest[];
      notifications?: AdminNotification[];
      products: Product[];
      promoCodes?: PromoCode[];
      socialLinks: SocialLink[];
      loyaltyCount: number;
      telegramStatus?: TelegramStatus;
    };

    const firestoreSnapshot = firestoreRes?.ok ? firestoreRes.snapshot : null;
    const hasAuthoritativeFirestoreCatalog = Boolean(
      firestoreSnapshot && firestoreSnapshot.products.length > 0
    );

    let resolvedProducts =
      hasAuthoritativeFirestoreCatalog && firestoreSnapshot
        ? firestoreSnapshot.products
        : data.products;
    let resolvedPromoCodes = data.promoCodes ?? [];
    let resolvedSocialLinks =
      hasAuthoritativeFirestoreCatalog &&
      firestoreSnapshot &&
      firestoreSnapshot.socialLinks.length > 0
        ? firestoreSnapshot.socialLinks
        : data.socialLinks;
    const prevStateSync = loadOwnerStateSync();

    if (!hasSyncedOnceRef.current) {
      hasSyncedOnceRef.current = true;
      const syncState = loadOwnerCatalogSync();
      const serverMap = new Map(data.products.map((p) => [p.id, p]));
      const needsAddedSync =
        !hasAuthoritativeFirestoreCatalog &&
        syncState.addedProducts.some((p) => !serverMap.has(p.id));
      const needsDeletedSync =
        !hasAuthoritativeFirestoreCatalog &&
        syncState.deletedIds.some((id) => serverMap.has(id));
      const needsUpdatedSync =
        !hasAuthoritativeFirestoreCatalog &&
        syncState.updatedProducts.some((p) => {
          const srv = serverMap.get(p.id);
          return (
            srv &&
            (srv.imageUrl !== p.imageUrl ||
              srv.priceIqd !== p.priceIqd ||
              srv.name !== p.name ||
              JSON.stringify(srv.sizePrices ?? {}) !==
                JSON.stringify(p.sizePrices ?? {}))
          );
        });

      const deletedPromoSet = new Set(prevStateSync.deletedPromoIds);
      const serverPromoIds = new Set(resolvedPromoCodes.map((p) => p.id));
      const needsPromoSync = prevStateSync.promoCodes.some(
        (p) => !deletedPromoSet.has(p.id) && !serverPromoIds.has(p.id)
      );
      const needsDeletedPromoSync = resolvedPromoCodes.some((p) =>
        deletedPromoSet.has(p.id)
      );
      const serverSocialUrls = new Set(resolvedSocialLinks.map((s) => s.url));
      const needsSocialSync =
        !hasAuthoritativeFirestoreCatalog &&
        prevStateSync.socialLinks.some((s) => !serverSocialUrls.has(s.url));

      if (
        needsAddedSync ||
        needsDeletedSync ||
        needsUpdatedSync ||
        needsPromoSync ||
        needsDeletedPromoSync ||
        needsSocialSync
      ) {
        try {
          const syncRes = await fetch(apiUrl('/api/admin/sync-catalog'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              ...(hasAuthoritativeFirestoreCatalog
                ? { addedProducts: [], updatedProducts: [], deletedIds: [] }
                : syncState),
              promoCodes: prevStateSync.promoCodes,
              deletedPromoIds: prevStateSync.deletedPromoIds,
              socialLinks: hasAuthoritativeFirestoreCatalog
                ? []
                : prevStateSync.socialLinks,
            }),
          });
          if (syncRes.ok) {
            const syncData = (await syncRes.json()) as {
              products?: Product[];
              promoCodes?: PromoCode[];
              socialLinks?: SocialLink[];
              syncedCount?: number;
            };
            if (!hasAuthoritativeFirestoreCatalog && Array.isArray(syncData.products)) {
              resolvedProducts = syncData.products;
            }
            if (Array.isArray(syncData.promoCodes)) {
              resolvedPromoCodes = syncData.promoCodes;
            }
            if (!hasAuthoritativeFirestoreCatalog && Array.isArray(syncData.socialLinks)) {
              resolvedSocialLinks = syncData.socialLinks;
            }
            if (!hasAuthoritativeFirestoreCatalog && (syncData.syncedCount ?? 0) > 0) {
              void onCatalogMutated();
            }
          }
        } catch {
          // Non-fatal fallback to server catalog
        }
      }
    }

    writeOwnerStateSync({
      promoCodes: resolvedPromoCodes,
      deletedPromoIds: prevStateSync.deletedPromoIds,
      socialLinks: resolvedSocialLinks,
    });

    setOrders(data.orders);
    setCustomRequests(data.customRequests);
    setNotifications(data.notifications ?? []);
    setProducts(resolvedProducts);
    setPromoCodes(resolvedPromoCodes);
    setSocialLinks(resolvedSocialLinks);
    setLoyaltyCount(data.loyaltyCount);
    if (data.telegramStatus) {
      setTelegramStatus(data.telegramStatus);
    }
  };

  useEffect(() => {
    if (token) {
      fetchDashboard(token);
    }
  }, [token]);

  // Real-Time Server-Sent Events (SSE) Stream for Immediate Owner Order Alerts
  useEffect(() => {
    if (!token) {
      setLiveStreamConnected(false);
      return;
    }

    let cancelled = false;
    let reconnectTimer: number | null = null;
    let activeController: AbortController | null = null;

    const triggerDesktopNotification = (title: string, body: string) => {
      if (soundEnabledRef.current) {
        playNotificationChime();
      }
      if (
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        try {
          new Notification(title, { body });
        } catch {
          // Ignore browser desktop notification restrictions
        }
      }
    };

    const connectStream = async () => {
      if (cancelled) return;
      activeController = new AbortController();
      try {
        const res = await fetch(apiUrl('/api/admin/notifications/stream'), {
          headers: { Authorization: `Bearer ${token}` },
          signal: activeController.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error('SSE stream failed');
        }
        setLiveStreamConnected(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            if (!frame.trim() || frame.startsWith(':')) continue;
            let eventName = 'message';
            const dataLines: string[] = [];
            for (const line of frame.split(/\r?\n/)) {
              if (line.startsWith('event:')) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trim());
              }
            }
            if (dataLines.length === 0) continue;
            try {
              const payload = JSON.parse(dataLines.join('\n')) as {
                order?: Order;
                request?: CustomPerfumeRequest;
                notification?: AdminNotification;
              };

              if (eventName === 'new_order' && payload.order) {
                const incomingOrder = payload.order;
                setOrders((prev) =>
                  prev.some((o) => o.id === incomingOrder.id)
                    ? prev
                    : [incomingOrder, ...prev]
                );
                if (payload.notification) {
                  const incomingNotif = payload.notification;
                  setNotifications((prev) =>
                    prev.some((n) => n.id === incomingNotif.id)
                      ? prev
                      : [incomingNotif, ...prev]
                  );
                }
                setStatusMessage(
                  `وصل طلب جديد الآن: ${incomingOrder.orderNumber} من ${incomingOrder.fullName} — جاهز للتجهيز!`
                );
                triggerDesktopNotification(
                  `طلب جديد ${incomingOrder.orderNumber} — بلوكرانا للعطور`,
                  `${incomingOrder.fullName} · ${incomingOrder.exactLocation} · ${formatIQD(incomingOrder.pricing.totalIqd)}`
                );
              } else if (eventName === 'custom_request' && payload.request) {
                const incomingReq = payload.request;
                setCustomRequests((prev) =>
                  prev.some((r) => r.id === incomingReq.id)
                    ? prev
                    : [incomingReq, ...prev]
                );
                if (payload.notification) {
                  const incomingNotif = payload.notification;
                  setNotifications((prev) =>
                    prev.some((n) => n.id === incomingNotif.id)
                      ? prev
                      : [incomingNotif, ...prev]
                  );
                }
                setStatusMessage(
                  `وصل طلب «وفرلي عطري» جديد: ${incomingReq.perfumeName} من ${incomingReq.customerName}.`
                );
                triggerDesktopNotification(
                  'طلب «وفرلي عطري» جديد — بلوكرانا',
                  `${incomingReq.perfumeName} (${incomingReq.size}) — ${incomingReq.customerName}`
                );
              }
            } catch {
              // Ignore malformed SSE payload
            }
          }
        }
      } catch {
        setLiveStreamConnected(false);
        if (!cancelled) {
          reconnectTimer = window.setTimeout(() => {
            void connectStream();
          }, 3000);
        }
      }
    };

    void connectStream();

    return () => {
      cancelled = true;
      setLiveStreamConnected(false);
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      activeController?.abort();
    };
  }, [token]);

  const handleAuthSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);
    const endpoint =
      authState.mode === 'unclaimed' ? '/api/admin/claim' : '/api/admin/login';
    try {
      const res = await fetch(apiUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: passcodeInput }),
      });
      const data = (await res.json()) as {
        token?: string;
        adminAuthState?: AdminAuthState;
        error?: string;
      };
      if (!res.ok || !data.token) {
        setAuthError(data.error ?? 'تعذر التحقق من الرمز.');
        return;
      }
      if (data.adminAuthState) {
        onAuthStateChange(data.adminAuthState);
      }
      setPasscodeInput('');
      setToken(data.token);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      setAuthError('حدث خطأ في الاتصال بالخادم.');
    } finally {
      setAuthLoading(false);
    }
  };

  const getOrderDraft = (order: Order): OrderEditDraft =>
    orderEdits[order.id] ?? {
      status: order.status,
      estimatedArrival: order.estimatedArrival || 'خلال 24 إلى 48 ساعة',
      statusMessage:
        order.statusMessage || DEFAULT_STATUS_MESSAGES[order.status],
    };

  const updateOrderDraft = (order: Order, patch: Partial<OrderEditDraft>) => {
    setOrderEdits((prev) => {
      const current = prev[order.id] ?? {
        status: order.status,
        estimatedArrival: order.estimatedArrival || 'خلال 24 إلى 48 ساعة',
        statusMessage:
          order.statusMessage || DEFAULT_STATUS_MESSAGES[order.status],
      };
      let nextMessage = patch.statusMessage ?? current.statusMessage;
      if (patch.status && patch.status !== current.status && patch.statusMessage === undefined) {
        const prevDefault = DEFAULT_STATUS_MESSAGES[current.status];
        if (!current.statusMessage.trim() || current.statusMessage === prevDefault) {
          nextMessage = DEFAULT_STATUS_MESSAGES[patch.status];
        }
      }
      return {
        ...prev,
        [order.id]: {
          ...current,
          ...patch,
          statusMessage: nextMessage,
        },
      };
    });
  };

  const handleSaveOrderUpdate = async (order: Order) => {
    const draft = getOrderDraft(order);
    setSavingOrderId(order.id);
    setStatusMessage('');
    try {
      const res = await fetch(apiUrl(`/api/admin/orders/${order.id}`), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          status: draft.status,
          estimatedArrival: draft.estimatedArrival,
          statusMessage: draft.statusMessage,
        }),
      });
      const data = (await res.json()) as { order?: Order; error?: string; code?: string };
      if (!res.ok || !data.order) {
        setStatusMessage(
          isMaintenanceResponse(res.status, data)
            ? data.error ?? 'المتجر في وضع الصيانة المؤقتة حالياً.'
            : data.error ?? 'تعذر حفظ تحديث الطلب.'
        );
        return;
      }
      const updated = data.order;
      setOrders((prev) =>
        prev.map((o) => (o.id === order.id ? updated : o))
      );
      setOrderEdits((prev) => ({
        ...prev,
        [order.id]: {
          status: updated.status,
          estimatedArrival: updated.estimatedArrival,
          statusMessage: updated.statusMessage,
        },
      }));
      setStatusMessage(
        `تم تحديث حالة الطلب ${updated.orderNumber} إلى «${updated.status}» وتحديد وقت الوصول بنجاح.`
      );
    } finally {
      setSavingOrderId(null);
    }
  };

  const handleMarkAllNotificationsRead = async () => {
    const res = await fetch(apiUrl('/api/admin/notifications/read-all'), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as {
        notifications?: AdminNotification[];
      };
      if (data.notifications) {
        setNotifications(data.notifications);
      } else {
        setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      }
    }
  };

  const handleRequestBrowserNotifications = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setBrowserNotifPermission('unsupported');
      return;
    }
    const result = await Notification.requestPermission();
    setBrowserNotifPermission(result);
    if (result === 'granted') {
      playNotificationChime();
      setStatusMessage('تم تفعيل إشعارات المتصفح الفورية للطلبات الجديدة.');
    }
  };

  const handleSaveTelegramConfig = async (e: FormEvent) => {
    e.preventDefault();
    setTgBusy(true);
    setStatusMessage('');
    try {
      const res = await fetch(apiUrl('/api/admin/telegram-config'), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          botToken: tgBotToken.trim(),
          chatId: tgChatId.trim(),
        }),
      });
      const data = (await res.json()) as {
        telegramStatus?: TelegramStatus;
        error?: string;
      };
      if (!res.ok || !data.telegramStatus) {
        setStatusMessage(data.error ?? 'تعذر حفظ إعدادات تيليغرام.');
        return;
      }
      setTelegramStatus(data.telegramStatus);
      setTgBotToken('');
      setTgChatId('');
      setStatusMessage(
        'تم ربط بوت تيليغرام بنجاح! يمكنك الضغط على «إرسال رسالة اختبار» للتأكد من وصول الإشعارات لهاتفك.'
      );
    } finally {
      setTgBusy(false);
    }
  };

  const handleDeleteTelegramConfig = async () => {
    setTgBusy(true);
    try {
      const res = await fetch(apiUrl('/api/admin/telegram-config'), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { telegramStatus?: TelegramStatus };
        if (data.telegramStatus) setTelegramStatus(data.telegramStatus);
        setStatusMessage('تم إلغاء ربط إشعارات تيليغرام.');
      }
    } finally {
      setTgBusy(false);
    }
  };

  const handleTestTelegram = async () => {
    setTgBusy(true);
    setStatusMessage('');
    try {
      const res = await fetch(apiUrl('/api/admin/telegram-test'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setStatusMessage(data.error ?? 'تعذر إرسال رسالة الاختبار.');
        return;
      }
      setStatusMessage(
        'تم إرسال رسالة الاختبار إلى حسابك في تيليغرام بنجاح!'
      );
    } finally {
      setTgBusy(false);
    }
  };

  const handleCustomStatusChange = async (
    reqId: string,
    status: CustomRequestStatus
  ) => {
    const res = await fetch(apiUrl(`/api/admin/custom-requests/${reqId}`), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      setCustomRequests((prev) =>
        prev.map((r) => (r.id === reqId ? { ...r, status } : r))
      );
      setStatusMessage('تم تحديث حالة طلب «وفرلي عطري».');
    } else {
      const errData = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (isMaintenanceResponse(res.status, errData)) {
        setStatusMessage(errData.error ?? 'المتجر في وضع الصيانة المؤقتة حالياً.');
      }
    }
  };

  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('تعذر قراءة الملف'));
      reader.readAsDataURL(file);
    });

  const compressImageDataUrlForTurso = async (
    rawDataUrl: string,
    maxDim = 1200,
    targetBinaryBytes = 1_150_000
  ): Promise<string> => {
    const approxBytes = Math.floor((rawDataUrl.length * 3) / 4);
    if (approxBytes <= targetBinaryBytes || typeof document === 'undefined') {
      return rawDataUrl;
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(rawDataUrl);
            return;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          for (const mime of ['image/webp', 'image/jpeg']) {
            for (const q of [0.85, 0.72, 0.58]) {
              const candidate = canvas.toDataURL(mime, q);
              const candidateBytes = Math.floor((candidate.length * 3) / 4);
              if (candidate.startsWith(`data:${mime};base64,`) && candidateBytes <= targetBinaryBytes) {
                resolve(candidate);
                return;
              }
            }
          }
          resolve(canvas.toDataURL('image/jpeg', 0.55) || rawDataUrl);
        } catch {
          resolve(rawDataUrl);
        }
      };
      img.onerror = () => resolve(rawDataUrl);
      img.src = rawDataUrl;
    });
  };

  const uploadImageFile = async (file: File): Promise<string | null> => {
    setStatusMessage('');
    try {
      const rawDataUrl = await readFileAsDataUrl(file);
      const dataUrl = await compressImageDataUrlForTurso(rawDataUrl);
      const res = await fetch(apiUrl('/api/admin/upload-image'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ dataUrl }),
      });
      const data = (await res.json()) as { imageUrl?: string; error?: string; code?: string };
      if (!res.ok || !data.imageUrl) {
        setStatusMessage(
          isMaintenanceResponse(res.status, data)
            ? data.error ?? 'المتجر في وضع الصيانة المؤقتة حالياً.'
            : data.error ?? 'تعذر رفع الصورة.'
        );
        return null;
      }
      return data.imageUrl;
    } catch {
      setStatusMessage('حدث خطأ أثناء رفع الصورة.');
      return null;
    }
  };

  const resetProductForm = () => {
    setEditingProductId(null);
    setPCode('');
    setPName('');
    setPBrand('بلوكرانا');
    setPCategory('blaugrana');
    setPPrice('30000');
    setPPrice30(String(BLAUGRANA_DEFAULT_SIZE_PRICES['30 مل']));
    setPPrice50(String(BLAUGRANA_DEFAULT_SIZE_PRICES['50 مل']));
    setPPrice100(String(BLAUGRANA_DEFAULT_SIZE_PRICES['100 مل']));
    setPSize('100 مل');
    setPTopNotes('');
    setPHeartNotes('');
    setPBaseNotes('');
    setPNotes('');
    setPLongevity('24 ساعة');
    setPSillage('فوحان قوي');
    setPDesc('');
    setPImageUrl(IMAGE_PRESETS[0].url);
    setPFreeTester(true);
    setPInStock(true);
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(ADMIN_DRAFT_STORAGE_KEY);
    }
  };

  const stageProductImageEdit = (product: Product, nextUrl: string) => {
    setPendingProductEdits((prev) => {
      const existing = prev[product.id] ?? {};
      if (nextUrl.trim() === product.imageUrl.trim()) {
        const restPatch = { ...existing };
        delete restPatch.imageUrl;
        if (Object.keys(restPatch).length === 0) {
          const nextAll = { ...prev };
          delete nextAll[product.id];
          return nextAll;
        }
        return { ...prev, [product.id]: restPatch };
      }
      return {
        ...prev,
        [product.id]: {
          ...existing,
          imageUrl: nextUrl,
        },
      };
    });
  };

  const BACKUP_WARNING_SUFFIX =
    ' — تحذير: تم الحفظ في قاعدة Firestore وظهرت التغييرات للزوار، لكن تعذر تحديث النسخة الاحتياطية المحلية (JSON).';

  const ensureVerifiedFirestoreOwner = (): User | null => {
    const candidate = firestoreOwnerUser ?? auth.currentUser;
    if (!isAuthorizedAdminUser(candidate)) {
      setBannerStatus(
        `يرجى تسجيل دخول Google بحساب المالك (${AUTHORIZED_ADMIN_EMAIL}) في لوحة المزامنة أعلاه لحفظ تغييرات العطور في Firestore.`,
        'error'
      );
      setActiveTab('products');
      window.setTimeout(() => {
        document
          .getElementById('firestore-migration-panel')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
      return null;
    }
    return candidate;
  };

  const commitCatalogWithNonFatalBackup = async (options: {
    mutation: CatalogMutationInput;
    syncLegacyBackup: () => Promise<boolean>;
  }) => {
    const verifiedUser = ensureVerifiedFirestoreOwner();
    if (!verifiedUser) {
      return { ok: false as const, backupWarning: false };
    }

    let commitResult;
    try {
      commitResult = await commitCatalogSyncToFirestore(
        {
          ...options.mutation,
          fallbackProducts: options.mutation.fallbackProducts ?? products,
          fallbackStoreInfo: options.mutation.fallbackStoreInfo ?? storeInfo,
          fallbackSocialLinks:
            options.mutation.fallbackSocialLinks ?? socialLinks,
        },
        { user: verifiedUser }
      );
    } catch (err) {
      const msg =
        err instanceof Error && err.message.trim()
          ? err.message
          : 'تعذر حفظ التغييرات في قاعدة Firestore. لم يتم المساس بالبيانات الحالية.';
      setBannerStatus(msg, 'error');
      return { ok: false as const, backupWarning: false };
    }

    setProducts(commitResult.products);
    setSocialLinks(commitResult.socialLinks);
    await onCatalogMutated();

    let backupWarning = false;
    try {
      const backupOk = await options.syncLegacyBackup();
      if (!backupOk) {
        backupWarning = true;
      }
    } catch {
      backupWarning = true;
    }

    return { ok: true as const, commitResult, backupWarning };
  };

  const handleSaveAllChanges = async (): Promise<boolean> => {
    const entries = Object.entries(pendingProductEdits);
    if (entries.length === 0) return true;

    const productById = new Map(products.map((p) => [p.id, p]));
    const sanitizedUpserts: Product[] = [];
    const legacyUpdates: Array<{
      id: string;
      imageUrl?: string;
      hasCustomImage?: boolean;
      priceIqd?: number;
      sizePrices?: Record<string, number>;
    }> = [];

    const validationTs = new Date().toISOString();
    for (const [id, patch] of entries) {
      const base = productById.get(id);
      if (!base) continue;

      const nextImg =
        typeof patch.imageUrl === 'string' && patch.imageUrl.trim()
          ? patch.imageUrl.trim()
          : base.imageUrl;
      const nextSizePrices = patch.sizePrices ?? base.sizePrices;
      const nextPrice =
        typeof patch.priceIqd === 'number' && Number.isFinite(patch.priceIqd)
          ? patch.priceIqd
          : nextSizePrices && typeof nextSizePrices['100 مل'] === 'number'
            ? nextSizePrices['100 مل']
            : base.priceIqd;

      const candidate: Product = {
        ...base,
        imageUrl: nextImg,
        hasCustomImage:
          typeof patch.imageUrl === 'string' && patch.imageUrl.trim()
            ? true
            : base.hasCustomImage,
        priceIqd: nextPrice,
        ...(nextSizePrices ? { sizePrices: nextSizePrices } : {}),
      };

      const check = sanitizeAndValidateProductForFirestore(
        candidate,
        validationTs
      );
      if (check.errors.length > 0 || !check.product) {
        setBannerStatus(
          check.errors[0] ?? 'توجد قيمة غير صالحة في التعديلات المعلقة.',
          'error'
        );
        return false;
      }

      sanitizedUpserts.push(check.product);
      const cleanPatch: {
        id: string;
        imageUrl?: string;
        hasCustomImage?: boolean;
        priceIqd?: number;
        sizePrices?: Record<string, number>;
      } = { id };
      if (typeof patch.imageUrl === 'string' && patch.imageUrl.trim()) {
        cleanPatch.imageUrl = check.product.imageUrl;
        cleanPatch.hasCustomImage = true;
      }
      if (
        typeof patch.priceIqd === 'number' &&
        Number.isFinite(patch.priceIqd)
      ) {
        cleanPatch.priceIqd = check.product.priceIqd;
      }
      if (patch.sizePrices && check.product.sizePrices) {
        cleanPatch.sizePrices = check.product.sizePrices;
      }
      if (
        cleanPatch.imageUrl !== undefined ||
        cleanPatch.priceIqd !== undefined ||
        cleanPatch.sizePrices !== undefined
      ) {
        legacyUpdates.push(cleanPatch);
      }
    }

    if (sanitizedUpserts.length === 0) {
      setPendingProductEdits({});
      return true;
    }

    setSavingAllChanges(true);
    setBannerStatus('', 'success');
    try {
      const result = await commitCatalogWithNonFatalBackup({
        mutation: { upsertProducts: sanitizedUpserts },
        syncLegacyBackup: async () => {
          if (legacyUpdates.length === 0) return true;
          const res = await fetch(apiUrl('/api/admin/products/bulk-update'), {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ updates: legacyUpdates }),
          });
          return res.ok;
        },
      });

      if (!result.ok) return false;

      recordOwnerUpdatedProducts(sanitizedUpserts);
      setPendingProductEdits({});
      setInlineImageProductId(null);
      setInlineImageUrl('');
      setBannerStatus(
        `تم حفظ جميع التغييرات (${sanitizedUpserts.length} عطر/منتج) في Firestore وتثبيتها في المتجر بنجاح.${
          result.backupWarning ? BACKUP_WARNING_SUFFIX : ''
        }`,
        result.backupWarning ? 'warning' : 'success'
      );
      return true;
    } finally {
      setSavingAllChanges(false);
    }
  };

  const handleDiscardAllChanges = () => {
    setPendingProductEdits({});
    setInlineImageProductId(null);
    setInlineImageUrl('');
    setBannerStatus('تم التراجع عن التعديلات غير المحفوظة.', 'success');
  };

  const handleSaveAllSiteChanges = async () => {
    if (savingSiteChanges || savingAllChanges) return;
    setSavingSiteChanges(true);
    setBannerStatus('', 'success');
    try {
      const entries = Object.entries(pendingProductEdits);
      let hadBackupWarning = false;
      if (entries.length > 0) {
        const savedOk = await handleSaveAllChanges();
        if (!savedOk) return;
      }

      if (isFirestoreOwnerVerified && (firestoreOwnerUser ?? auth.currentUser)) {
        const syncRes = await commitCatalogWithNonFatalBackup({
          mutation: {
            socialLinksOverride: socialLinks,
            storeInfoOverride: storeInfo,
          },
          syncLegacyBackup: async () => {
            const catalogSync = loadOwnerCatalogSync();
            const stateSync = loadOwnerStateSync();
            const res = await fetch(apiUrl('/api/admin/save-all'), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                ...catalogSync,
                promoCodes,
                deletedPromoIds: stateSync.deletedPromoIds,
                socialLinks,
              }),
            });
            if (!res.ok) return false;
            const data = (await res.json()) as {
              promoCodes?: PromoCode[];
              socialLinks?: SocialLink[];
              telegramStatus?: TelegramStatus;
            };
            if (Array.isArray(data.promoCodes)) setPromoCodes(data.promoCodes);
            if (data.telegramStatus) setTelegramStatus(data.telegramStatus);
            writeOwnerStateSync({
              promoCodes: data.promoCodes ?? promoCodes,
              deletedPromoIds: stateSync.deletedPromoIds,
              socialLinks: data.socialLinks ?? socialLinks,
            });
            return true;
          },
        });
        if (!syncRes.ok) return;
        hadBackupWarning = syncRes.backupWarning;
      } else {
        const catalogSync = loadOwnerCatalogSync();
        const stateSync = loadOwnerStateSync();
        const res = await fetch(apiUrl('/api/admin/save-all'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            ...catalogSync,
            promoCodes,
            deletedPromoIds: stateSync.deletedPromoIds,
            socialLinks,
          }),
        });
        if (!res.ok) {
          setBannerStatus('تعذر حفظ التغييرات على الخادم المحلي.', 'error');
          return;
        }
        const data = (await res.json()) as {
          promoCodes?: PromoCode[];
          socialLinks?: SocialLink[];
          telegramStatus?: TelegramStatus;
        };
        if (Array.isArray(data.promoCodes)) setPromoCodes(data.promoCodes);
        if (Array.isArray(data.socialLinks)) setSocialLinks(data.socialLinks);
        if (data.telegramStatus) setTelegramStatus(data.telegramStatus);
        writeOwnerStateSync({
          promoCodes: data.promoCodes ?? promoCodes,
          deletedPromoIds: stateSync.deletedPromoIds,
          socialLinks: data.socialLinks ?? socialLinks,
        });
        await onCatalogMutated();
      }

      setBannerStatus(
        `تم حفظ جميع التغييرات على الموقع وتثبيتها بنجاح.${
          hadBackupWarning ? BACKUP_WARNING_SUFFIX : ''
        }`,
        hadBackupWarning ? 'warning' : 'success'
      );
    } catch {
      setBannerStatus(
        'حدث خطأ في الاتصال بالخادم أثناء حفظ تغييرات الموقع.',
        'error'
      );
    } finally {
      setSavingSiteChanges(false);
    }
  };

  const startEditingProduct = (product: Product) => {
    setEditingProductId(product.id);
    setPCode(product.code);
    setPName(product.name);
    setPBrand(product.brand);
    setPCategory(product.category);
    setPPrice(String(product.priceIqd));
    setPPrice30(
      String(
        product.sizePrices?.['30 مل'] ?? BLAUGRANA_DEFAULT_SIZE_PRICES['30 مل']
      )
    );
    setPPrice50(
      String(
        product.sizePrices?.['50 مل'] ?? BLAUGRANA_DEFAULT_SIZE_PRICES['50 مل']
      )
    );
    setPPrice100(
      String(product.sizePrices?.['100 مل'] ?? product.priceIqd)
    );
    setPSize(product.size);
    setPTopNotes(product.topNotes ?? '');
    setPHeartNotes(product.heartNotes ?? '');
    setPBaseNotes(product.baseNotes ?? '');
    setPNotes(product.notes);
    setPLongevity(product.longevity);
    setPSillage(product.sillage);
    setPDesc(product.description);
    setPImageUrl(pendingProductEdits[product.id]?.imageUrl ?? product.imageUrl);
    setPFreeTester(product.includesFreeTester);
    setPInStock(product.inStock);
    productFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleFormImageUpload = async (file: File | undefined) => {
    if (!file) return;
    setUploadingFormImage(true);
    const uploadedUrl = await uploadImageFile(file);
    setUploadingFormImage(false);
    if (uploadedUrl) {
      setPImageUrl(uploadedUrl);
      setBannerStatus(
        'تم رفع الصورة بنجاح، اضغط حفظ التعديلات لتأكيدها في Firestore.',
        'success'
      );
    }
  };

  const handleInlineImageUpload = async (
    product: Product,
    file: File | undefined
  ) => {
    if (!file) return;
    setUploadingInlineImage(true);
    const uploadedUrl = await uploadImageFile(file);
    setUploadingInlineImage(false);
    if (!uploadedUrl) return;
    setInlineImageUrl(uploadedUrl);
    await saveInlineProductImage(product, uploadedUrl);
  };

  const saveInlineProductImage = async (product: Product, imageUrl: string) => {
    const trimmed = imageUrl.trim();
    if (!trimmed) return;
    setBannerStatus('', 'success');

    const candidate: Product = {
      ...product,
      imageUrl: trimmed,
      hasCustomImage: true,
    };
    const check = sanitizeAndValidateProductForFirestore(
      candidate,
      new Date().toISOString()
    );
    if (check.errors.length > 0 || !check.product) {
      setBannerStatus(check.errors[0] ?? 'رابط الصورة غير صالح.', 'error');
      return;
    }
    const sanitizedProduct = check.product;

    const result = await commitCatalogWithNonFatalBackup({
      mutation: { upsertProducts: [sanitizedProduct] },
      syncLegacyBackup: async () => {
        const res = await fetch(apiUrl(`/api/admin/products/${product.id}`), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            imageUrl: sanitizedProduct.imageUrl,
            hasCustomImage: true,
          }),
        });
        return res.ok;
      },
    });
    if (!result.ok) return;

    recordOwnerUpdatedProducts([sanitizedProduct]);
    setPendingProductEdits((prev) => {
      const next = { ...prev };
      delete next[product.id];
      return next;
    });
    setInlineImageProductId(null);
    setInlineImageUrl('');
    setBannerStatus(
      `تم تحديث صورة عطر #${product.code} (${product.name}) في Firestore بنجاح.${
        result.backupWarning ? BACKUP_WARNING_SUFFIX : ''
      }`,
      result.backupWarning ? 'warning' : 'success'
    );
  };

  const saveInlineProductPrice = async (product: Product) => {
    setBannerStatus('', 'success');
    const isMultiSize =
      product.category === 'blaugrana' || Boolean(product.sizePrices);
    const candidate: Product = isMultiSize
      ? {
          ...product,
          priceIqd: Number(inlinePrice100),
          sizePrices: {
            '30 مل': Number(inlinePrice30),
            '50 مل': Number(inlinePrice50),
            '100 مل': Number(inlinePrice100),
          },
        }
      : {
          ...product,
          priceIqd: Number(inlineSinglePrice),
        };

    const check = sanitizeAndValidateProductForFirestore(
      candidate,
      new Date().toISOString()
    );
    if (check.errors.length > 0 || !check.product) {
      setBannerStatus(check.errors[0] ?? 'السعر المدخل غير صالح.', 'error');
      return;
    }
    const sanitizedProduct = check.product;

    const result = await commitCatalogWithNonFatalBackup({
      mutation: { upsertProducts: [sanitizedProduct] },
      syncLegacyBackup: async () => {
        const payload = isMultiSize
          ? {
              priceIqd: sanitizedProduct.priceIqd,
              sizePrices: sanitizedProduct.sizePrices,
            }
          : {
              priceIqd: sanitizedProduct.priceIqd,
            };
        const res = await fetch(apiUrl(`/api/admin/products/${product.id}`), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });
        return res.ok;
      },
    });
    if (!result.ok) return;

    recordOwnerUpdatedProducts([sanitizedProduct]);
    setPendingProductEdits((prev) => {
      const next = { ...prev };
      delete next[product.id];
      return next;
    });
    setInlinePriceProductId(null);
    setBannerStatus(
      `تم تحديث سعر عطر #${product.code} (${product.name}) في Firestore بنجاح.${
        result.backupWarning ? BACKUP_WARNING_SUFFIX : ''
      }`,
      result.backupWarning ? 'warning' : 'success'
    );
  };

  const handleBulkBlaugranaSizePrices = async (e: FormEvent) => {
    e.preventDefault();
    setBulkPriceBusy(true);
    setBannerStatus('', 'success');
    try {
      const p30 = Math.round(Number(bulkPrice30));
      const p50 = Math.round(Number(bulkPrice50));
      const p100 = Math.round(Number(bulkPrice100));
      if (
        !Number.isFinite(p30) ||
        p30 < 500 ||
        !Number.isFinite(p50) ||
        p50 < 500 ||
        !Number.isFinite(p100) ||
        p100 < 500
      ) {
        setBannerStatus(
          'يرجى إدخال أسعار صحيحة (500 د.ع فأكثر) لأحجام 30 مل و50 مل و100 مل.',
          'error'
        );
        return;
      }

      const validationTs = new Date().toISOString();
      const updatedBlaugrana: Product[] = [];
      for (const product of products) {
        if (product.category !== 'blaugrana') continue;
        const candidate: Product = {
          ...product,
          size: '100 مل',
          priceIqd: p100,
          sizePrices: {
            '30 مل': p30,
            '50 مل': p50,
            '100 مل': p100,
          },
        };
        const check = sanitizeAndValidateProductForFirestore(
          candidate,
          validationTs
        );
        if (check.errors.length > 0 || !check.product) {
          setBannerStatus(
            check.errors[0] ?? 'تعذر التحقق من بيانات العطور قبل التحديث.',
            'error'
          );
          return;
        }
        updatedBlaugrana.push(check.product);
      }

      if (updatedBlaugrana.length === 0) {
        setBannerStatus('لا توجد عطور ضمن قسم بلوكرانا للتحديث.', 'error');
        return;
      }

      const result = await commitCatalogWithNonFatalBackup({
        mutation: { upsertProducts: updatedBlaugrana },
        syncLegacyBackup: async () => {
          const res = await fetch(apiUrl('/api/admin/products/bulk-prices'), {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              mode: 'blaugrana_sizes',
              price30: p30,
              price50: p50,
              price100: p100,
            }),
          });
          return res.ok;
        },
      });
      if (!result.ok) return;

      recordOwnerUpdatedProducts(updatedBlaugrana);
      setBannerStatus(
        `تم تحديث أسعار الأحجام (30 / 50 / 100 مل) لجميع عطور بلوكرانا (${updatedBlaugrana.length} عطر) في Firestore بنجاح.${
          result.backupWarning ? BACKUP_WARNING_SUFFIX : ''
        }`,
        result.backupWarning ? 'warning' : 'success'
      );
    } finally {
      setBulkPriceBusy(false);
    }
  };

  const handleBulkCategoryPriceAdjust = async (e: FormEvent) => {
    e.preventDefault();
    setBulkPriceBusy(true);
    setBannerStatus('', 'success');
    try {
      const value = Number(bulkAdjustValue);
      if (!Number.isFinite(value)) {
        setBannerStatus('قيمة التعديل غير صالحة.', 'error');
        return;
      }
      if (bulkAdjustType === 'fixed_price' && value < 500) {
        setBannerStatus('السعر الموحد يجب أن لا يقل عن 500 د.ع.', 'error');
        return;
      }
      if (bulkAdjustType === 'percent' && (value <= -95 || value > 500)) {
        setBannerStatus(
          'النسبة المئوية يجب أن تكون بين -95% و 500%.',
          'error'
        );
        return;
      }

      const applyAdjustment = (oldPrice: number): number => {
        if (bulkAdjustType === 'fixed_price') {
          return Math.max(500, Math.round(value));
        }
        if (bulkAdjustType === 'percent') {
          return Math.max(500, Math.round((oldPrice * (100 + value)) / 100));
        }
        return Math.max(500, Math.round(oldPrice + value));
      };

      const validationTs = new Date().toISOString();
      const affectedSanitized: Product[] = [];
      for (const product of products) {
        if (bulkCategory !== 'all' && product.category !== bulkCategory) {
          continue;
        }
        const nextPrice = applyAdjustment(product.priceIqd);
        let nextSizePrices = product.sizePrices;
        if (product.sizePrices) {
          const updatedSizes: Record<string, number> = {};
          for (const [sz, oldSzPrice] of Object.entries(product.sizePrices)) {
            updatedSizes[sz] = applyAdjustment(oldSzPrice);
          }
          nextSizePrices = updatedSizes;
        }
        const candidate: Product = {
          ...product,
          priceIqd:
            nextSizePrices && typeof nextSizePrices['100 مل'] === 'number'
              ? nextSizePrices['100 مل']
              : nextPrice,
          ...(nextSizePrices ? { sizePrices: nextSizePrices } : {}),
        };
        const check = sanitizeAndValidateProductForFirestore(
          candidate,
          validationTs
        );
        if (check.errors.length > 0 || !check.product) {
          setBannerStatus(
            check.errors[0] ?? 'تعذر التحقق من بيانات الأسعار المعدّلة.',
            'error'
          );
          return;
        }
        affectedSanitized.push(check.product);
      }

      if (affectedSanitized.length === 0) {
        setBannerStatus('لا توجد منتجات ضمن القسم المحدد.', 'error');
        return;
      }

      const result = await commitCatalogWithNonFatalBackup({
        mutation: { upsertProducts: affectedSanitized },
        syncLegacyBackup: async () => {
          const res = await fetch(apiUrl('/api/admin/products/bulk-prices'), {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              mode: 'category_adjust',
              category: bulkCategory,
              adjustType: bulkAdjustType,
              value,
            }),
          });
          return res.ok;
        },
      });
      if (!result.ok) return;

      recordOwnerUpdatedProducts(affectedSanitized);
      setBulkAdjustValue('');
      setBannerStatus(
        `تم تطبيق تغيير الأسعار الجماعي على ${affectedSanitized.length} منتج وعطر في Firestore بنجاح.${
          result.backupWarning ? BACKUP_WARNING_SUFFIX : ''
        }`,
        result.backupWarning ? 'warning' : 'success'
      );
    } finally {
      setBulkPriceBusy(false);
    }
  };

  const handleProductSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (savingProduct) return;
    setBannerStatus('', 'success');
    setSavingProduct(true);
    try {
      const combinedNotes = [pTopNotes, pHeartNotes, pBaseNotes]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' · ');

      const usesMultiSize = pCategory === 'blaugrana';
      const sizePricesPayload = usesMultiSize
        ? {
            '30 مل': Number(pPrice30) || BLAUGRANA_DEFAULT_SIZE_PRICES['30 مل'],
            '50 مل': Number(pPrice50) || BLAUGRANA_DEFAULT_SIZE_PRICES['50 مل'],
            '100 مل': Number(pPrice100) || BLAUGRANA_DEFAULT_SIZE_PRICES['100 مل'],
          }
        : undefined;

      const wasEditing = Boolean(editingProductId);
      const targetId = editingProductId ?? generateValidProductId(pCategory);

      const candidateProduct: Product = {
        id: targetId,
        code: pCode.trim(),
        name: pName.trim(),
        brand: pBrand.trim(),
        category: pCategory,
        priceIqd: usesMultiSize
          ? sizePricesPayload!['100 مل']
          : Number(pPrice),
        ...(sizePricesPayload ? { sizePrices: sizePricesPayload } : {}),
        size: pSize.trim(),
        ...(pTopNotes.trim() ? { topNotes: pTopNotes.trim() } : {}),
        ...(pHeartNotes.trim() ? { heartNotes: pHeartNotes.trim() } : {}),
        ...(pBaseNotes.trim() ? { baseNotes: pBaseNotes.trim() } : {}),
        notes: combinedNotes || pNotes.trim(),
        longevity: pLongevity.trim(),
        sillage: pSillage.trim(),
        description: pDesc.trim(),
        imageUrl: pImageUrl.trim(),
        hasCustomImage: Boolean(pImageUrl.trim()),
        includesFreeTester: pFreeTester,
        inStock: pInStock,
      };

      const check = sanitizeAndValidateProductForFirestore(
        candidateProduct,
        new Date().toISOString()
      );
      if (check.errors.length > 0 || !check.product) {
        setBannerStatus(
          check.errors[0] ?? 'يرجى التحقق من جميع بيانات العطر المدخلة.',
          'error'
        );
        return;
      }
      const sanitizedProduct = check.product;

      const result = await commitCatalogWithNonFatalBackup({
        mutation: { upsertProducts: [sanitizedProduct] },
        syncLegacyBackup: async () => {
          if (wasEditing) {
            const res = await fetch(apiUrl(`/api/admin/products/${targetId}`), {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                code: sanitizedProduct.code,
                name: sanitizedProduct.name,
                brand: sanitizedProduct.brand,
                category: sanitizedProduct.category,
                priceIqd: sanitizedProduct.priceIqd,
                ...(sanitizedProduct.sizePrices
                  ? { sizePrices: sanitizedProduct.sizePrices }
                  : {}),
                size: sanitizedProduct.size,
                topNotes: sanitizedProduct.topNotes ?? '',
                heartNotes: sanitizedProduct.heartNotes ?? '',
                baseNotes: sanitizedProduct.baseNotes ?? '',
                notes: sanitizedProduct.notes,
                longevity: sanitizedProduct.longevity,
                sillage: sanitizedProduct.sillage,
                description: sanitizedProduct.description,
                imageUrl: sanitizedProduct.imageUrl,
                hasCustomImage: sanitizedProduct.hasCustomImage,
                includesFreeTester: sanitizedProduct.includesFreeTester,
                inStock: sanitizedProduct.inStock,
              }),
            });
            return res.ok;
          }

          const res = await fetch(apiUrl('/api/admin/save-all'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              addedProducts: [sanitizedProduct],
            }),
          });
          return res.ok;
        },
      });

      if (!result.ok) return;

      if (wasEditing) {
        recordOwnerUpdatedProducts([sanitizedProduct]);
        setPendingProductEdits((prev) => {
          const next = { ...prev };
          delete next[sanitizedProduct.id];
          return next;
        });
      } else {
        recordOwnerAddedProducts([sanitizedProduct]);
        setAdminProductSearch('');
        setProductFilterMode('all');
      }

      resetProductForm();
      setBannerStatus(
        `${
          wasEditing
            ? 'تم تعديل العطر وحفظه في Firestore والمتجر بنجاح.'
            : 'تمت إضافة العطر إلى Firestore والمتجر بنجاح.'
        }${result.backupWarning ? BACKUP_WARNING_SUFFIX : ''}`,
        result.backupWarning ? 'warning' : 'success'
      );
    } finally {
      setSavingProduct(false);
    }
  };

  const handleBulkAdd = async (e: FormEvent) => {
    e.preventDefault();
    setBannerStatus('', 'success');
    const lines = bulkText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    const validationTs = new Date().toISOString();
    const createdProducts: Product[] = [];
    for (const line of lines) {
      const parts = line.split('|').map((s) => s.trim());
      const brand = parts[2] || 'بلوكرانا';
      const category: ProductCategory =
        parts[2] && parts[2] !== 'بلوكرانا' ? 'other_brands' : 'blaugrana';
      const parsedPrice = Number(parts[3]) || 30000;
      const candidate: Product = {
        id: generateValidProductId(category),
        code: parts[0] ?? '100',
        name: parts[1] ?? 'عطر بلوكرانا',
        brand,
        category,
        priceIqd: parsedPrice,
        ...(category === 'blaugrana'
          ? {
              sizePrices: {
                ...BLAUGRANA_DEFAULT_SIZE_PRICES,
                ...(parsedPrice >= 500 ? { '100 مل': parsedPrice } : {}),
              },
            }
          : {}),
        size: parts[4] || '100 مل',
        notes: 'تركيبة عطرية فاخرة من وكالة بلوكرانا.',
        longevity: '24 ساعة',
        sillage: 'فوحان ممتاز',
        description: 'منتج أصلي من وكالة بلوكرانا بضمان الثبات والفوحان.',
        imageUrl:
          category === 'blaugrana'
            ? IMAGE_PRESETS[0].url
            : IMAGE_PRESETS[1].url,
        hasCustomImage: false,
        includesFreeTester: true,
        inStock: true,
      };
      const check = sanitizeAndValidateProductForFirestore(
        candidate,
        validationTs
      );
      if (check.errors.length > 0 || !check.product) {
        setBannerStatus(
          check.errors[0] ?? 'تأكد من تنسيق قائمة الإضافة السريعة.',
          'error'
        );
        return;
      }
      createdProducts.push(check.product);
    }

    const result = await commitCatalogWithNonFatalBackup({
      mutation: { upsertProducts: createdProducts },
      syncLegacyBackup: async () => {
        const res = await fetch(apiUrl('/api/admin/save-all'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ addedProducts: createdProducts }),
        });
        return res.ok;
      },
    });
    if (!result.ok) return;

    recordOwnerAddedProducts(createdProducts);
    setBulkText('');
    setAdminProductSearch('');
    setProductFilterMode('all');
    setBannerStatus(
      `تمت إضافة ${createdProducts.length} عطور دفعة واحدة وحفظها في Firestore بنجاح.${
        result.backupWarning ? BACKUP_WARNING_SUFFIX : ''
      }`,
      result.backupWarning ? 'warning' : 'success'
    );
  };

  const handleDeleteProduct = async (productId: string) => {
    setBannerStatus('', 'success');
    const result = await commitCatalogWithNonFatalBackup({
      mutation: { deleteProductIds: [productId] },
      syncLegacyBackup: async () => {
        const res = await fetch(apiUrl(`/api/admin/products/${productId}`), {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        return res.ok || res.status === 404;
      },
    });
    if (!result.ok) return;

    recordOwnerDeletedProduct(productId);
    setPendingProductEdits((prev) => {
      const next = { ...prev };
      delete next[productId];
      return next;
    });
    if (editingProductId === productId) {
      resetProductForm();
    }
    setBannerStatus(
      `تم حذف المنتج من قاعدة Firestore والمتجر بنجاح.${
        result.backupWarning ? BACKUP_WARNING_SUFFIX : ''
      }`,
      result.backupWarning ? 'warning' : 'success'
    );
  };

  const handleAddPromoCode = async (e: FormEvent) => {
    e.preventDefault();
    setPromoBusy(true);
    setStatusMessage('');
    const parsedDuration = Math.round(Number(promoDurationDays || 0));
    try {
      const res = await fetch(apiUrl('/api/admin/promo-codes'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          code: promoCodeInput.trim(),
          ownerName: promoOwnerInput.trim(),
          discountType: promoDiscountType,
          discountValue: Number(promoDiscountValue),
          durationDays: parsedDuration > 0 ? parsedDuration : 0,
        }),
      });
      const data = (await res.json()) as {
        promoCode?: PromoCode;
        error?: string;
      };
      if (!res.ok || !data.promoCode) {
        setStatusMessage(data.error ?? 'تعذر إنشاء البروموكود.');
        return;
      }
      const prevSync = loadOwnerStateSync();
      const nextPromos = [
        data.promoCode,
        ...promoCodes.filter((p) => p.id !== data.promoCode!.id),
      ];
      writeOwnerStateSync({
        promoCodes: nextPromos,
        deletedPromoIds: prevSync.deletedPromoIds.filter(
          (id) => id !== data.promoCode!.id
        ),
        socialLinks,
      });
      setPromoCodeInput('');
      setPromoOwnerInput('');
      setPromoDiscountValue('10');
      setPromoDurationDays('30');
      await fetchDashboard(token);
      setStatusMessage(
        `تم حفظ وتفعيل كود الخصم «${data.promoCode.code}» باسم «${data.promoCode.ownerName}»${
          data.promoCode.durationDays
            ? ` لمدة ${data.promoCode.durationDays} يوم`
            : ' (صلاحية دائمة)'
        } بنجاح.`
      );
    } finally {
      setPromoBusy(false);
    }
  };

  const handleTogglePromoCode = async (promo: PromoCode) => {
    const res = await fetch(apiUrl(`/api/admin/promo-codes/${promo.id}`), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ active: !promo.active }),
    });
    if (res.ok) {
      await fetchDashboard(token);
      setStatusMessage(
        `تم ${!promo.active ? 'تفعيل' : 'إيقاف'} بروموكود «${promo.code}».`
      );
    }
  };

  const handleDeletePromoCode = async (promo: PromoCode) => {
    const res = await fetch(apiUrl(`/api/admin/promo-codes/${promo.id}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const prevSync = loadOwnerStateSync();
      const deletedSet = new Set(prevSync.deletedPromoIds);
      deletedSet.add(promo.id);
      writeOwnerStateSync({
        promoCodes: prevSync.promoCodes.filter((p) => p.id !== promo.id),
        deletedPromoIds: Array.from(deletedSet),
        socialLinks,
      });
      await fetchDashboard(token);
      setStatusMessage(`تم حذف بروموكود «${promo.code}».`);
    }
  };

  const handleAddSocialLink = async (e: FormEvent) => {
    e.preventDefault();
    setBannerStatus('', 'success');
    const platform = sPlatform.trim();
    const label = (sLabel || sPlatform).trim();
    const handle = sHandle.trim();
    const safeUrl = sanitizeHref(sUrl.trim());
    if (!platform || !handle || safeUrl === '#') {
      setBannerStatus(
        'يرجى إدخال اسم المنصة والمعرّف ورابط صحيح يبدأ بـ https://.',
        'error'
      );
      return;
    }

    const nextLink: SocialLink = {
      id: `soc-${
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID().slice(0, 8)
          : Date.now().toString(36)
      }`,
      platform,
      label: label || platform,
      handle,
      url: safeUrl,
    };
    const nextLinks = [...socialLinks, nextLink];

    const result = await commitCatalogWithNonFatalBackup({
      mutation: { socialLinksOverride: nextLinks },
      syncLegacyBackup: async () => {
        const res = await fetch(apiUrl('/api/admin/save-all'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ socialLinks: [nextLink] }),
        });
        return res.ok;
      },
    });
    if (!result.ok) return;

    setSPlatform('');
    setSLabel('');
    setSHandle('');
    setSUrl('');
    setBannerStatus(
      `تمت إضافة رابط التواصل في Firestore بنجاح.${
        result.backupWarning ? BACKUP_WARNING_SUFFIX : ''
      }`,
      result.backupWarning ? 'warning' : 'success'
    );
  };

  const handleDeleteSocialLink = async (id: string) => {
    setBannerStatus('', 'success');
    const nextLinks = socialLinks.filter((s) => s.id !== id);
    const result = await commitCatalogWithNonFatalBackup({
      mutation: { socialLinksOverride: nextLinks },
      syncLegacyBackup: async () => {
        const res = await fetch(apiUrl(`/api/admin/social-links/${id}`), {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        return res.ok || res.status === 404;
      },
    });
    if (!result.ok) return;

    setBannerStatus(
      `تم حذف رابط التواصل من Firestore بنجاح.${
        result.backupWarning ? BACKUP_WARNING_SUFFIX : ''
      }`,
      result.backupWarning ? 'warning' : 'success'
    );
  };

  // Unauthenticated View (Passcode Login or First-Run Setup)
  if (!token) {
    return (
      <main className="min-h-[80vh] bg-[#FAF8F5] py-16 px-4">
        <div className="max-w-md mx-auto bg-white rounded-2xl border border-black/10 p-8 shadow-sm space-y-6">
          <div className="flex items-center justify-between">
            <div className="w-11 h-11 rounded-xl bg-[#14213D] text-white flex items-center justify-center">
              <Lock className="w-5 h-5" aria-hidden="true" />
            </div>
            <button
              type="button"
              onClick={onExitAdmin}
              className="inline-flex items-center gap-1.5 text-sm text-[#5A5E6B] hover:text-[#14213D] cursor-pointer"
            >
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
              <span>العودة للمتجر</span>
            </button>
          </div>

          <div>
            <h1 className="font-display text-3xl font-bold text-[#14213D]">
              {authState.mode === 'unclaimed'
                ? 'تفعيل رمز الإدارة الخاصة'
                : 'دخول الإدارة الخاصة'}
            </h1>
            <p className="text-sm text-[#5A5E6B] mt-2 leading-relaxed">
              {authState.mode === 'unclaimed'
                ? 'أدخل الرمز السري المخصص لإدارة وكالة بلوكرانا لحفظه بشكل مشفّر وتفعيل لوحة التحكم لأول مرة.'
                : 'أدخل رمز الإدارة السري للوصول إلى الطلبات، إضافة العطور، وإدارة مواقع التواصل.'}
            </p>
          </div>

          <form onSubmit={handleAuthSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="admin-passcode-input"
                className="block text-sm font-semibold text-[#14213D] mb-1.5"
              >
                رمز الإدارة
              </label>
              <input
                id="admin-passcode-input"
                type="password"
                dir="ltr"
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
                placeholder="أدخل الرمز السري"
                className="w-full px-4 py-2.5 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg text-center tracking-widest tabular-nums focus:outline-2 focus:outline-[#6B1D2F]"
              />
            </div>

            {authError && (
              <p role="alert" className="text-xs text-[#9E1C28]">
                {authError}
              </p>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className="w-full py-3 px-6 text-sm font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] disabled:opacity-50 rounded-lg transition-colors cursor-pointer min-h-[44px]"
            >
              {authLoading
                ? 'جاري التحقق...'
                : authState.mode === 'unclaimed'
                  ? 'حفظ الرمز والدخول للإدارة'
                  : 'تسجيل الدخول'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // Authenticated Admin Workspace
  return (
    <main className="min-h-screen bg-[#FAF8F5] py-8 px-4 sm:px-8">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-black/10">
          <div>
            <p className="text-xs font-semibold text-[#6B1D2F]">
              لوحة تحكم وكالة بلوكرانا للعطور
            </p>
            <h1 className="font-display text-3xl font-bold text-[#14213D] mt-1">
              الإدارة الخاصة
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleSaveAllSiteChanges}
              disabled={savingSiteChanges || savingAllChanges}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-[#1E6B52] hover:bg-[#17523E] disabled:opacity-50 rounded-lg shadow-sm cursor-pointer"
            >
              <Save className="w-4 h-4" aria-hidden="true" />
              <span>
                {savingSiteChanges
                  ? 'جاري الحفظ...'
                  : pendingChangesCount > 0
                    ? `حفظ جميع التغييرات على الموقع (${pendingChangesCount})`
                    : 'حفظ جميع التغييرات على الموقع'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('products');
                window.setTimeout(() => {
                  document
                    .getElementById('firestore-migration-panel')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 60);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white bg-[#6B1D2F] hover:bg-[#14213D] rounded-lg shadow-sm cursor-pointer transition-colors"
            >
              <Database className="w-4 h-4 text-[#E8CFA0]" aria-hidden="true" />
              <span>الترحيل إلى Firestore</span>
            </button>

            <button
              type="button"
              onClick={onExitAdmin}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-[#14213D] bg-[#F2EFE9] hover:bg-[#E5E0D5] rounded-lg cursor-pointer"
            >
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
              <span>معاينة المتجر</span>
            </button>

            <button
              type="button"
              onClick={() => {
                hasSyncedOnceRef.current = false;
                setToken('');
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-[#9E1C28] border border-[#9E1C28]/25 hover:bg-[#FDF2F2] rounded-lg cursor-pointer"
            >
              <LogOut className="w-4 h-4" aria-hidden="true" />
              <span>تسجيل خروج</span>
            </button>
          </div>
        </div>

        {/* Unread Real-Time Owner Alert Banner */}
        {unreadNotificationsCount > 0 && (
          <div
            role="region"
            aria-label="إشعارات الطلبات الجديدة"
            className="rounded-2xl bg-[#14213D] text-white p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-md"
          >
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-xl bg-[#A67C37] text-[#14213D] flex items-center justify-center shrink-0">
                <BellRing className="w-5 h-5" aria-hidden="true" />
              </div>
              <div>
                <p className="font-bold text-base">
                  وصلتك {unreadNotificationsCount} إشعارات طلبات جديدة بانتظار التجهيز!
                </p>
                {notifications[0] && (
                  <p className="text-xs text-[#E5DFD3] mt-1">
                    أحدث إشعار: {notifications[0].customerName} —{' '}
                    {notifications[0].itemsSummary}
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => setActiveTab('orders')}
                className="px-4 py-2 text-xs font-bold bg-[#A67C37] hover:bg-[#BC924B] text-[#14213D] rounded-lg cursor-pointer"
              >
                عرض وتجهيز الطلبات
              </button>
              <button
                type="button"
                onClick={handleMarkAllNotificationsRead}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-white/10 hover:bg-white/20 text-white rounded-lg cursor-pointer"
              >
                <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />
                <span>تعليم الكل كمقروء</span>
              </button>
            </div>
          </div>
        )}

        {/* Summary KPI Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 tabular-nums">
          <div className="p-4 bg-white rounded-xl border border-black/10">
            <p className="text-xs text-[#5A5E6B]">الطلبات المستلمة</p>
            <p className="text-2xl font-bold text-[#14213D] mt-1">
              {orders.length}
            </p>
          </div>
          <div className="p-4 bg-white rounded-xl border border-black/10">
            <p className="text-xs text-[#5A5E6B]">طلبات «وفرلي عطري»</p>
            <p className="text-2xl font-bold text-[#6B1D2F] mt-1">
              {customRequests.length}
            </p>
          </div>
          <div className="p-4 bg-white rounded-xl border border-black/10">
            <p className="text-xs text-[#5A5E6B]">العطور والمنتجات</p>
            <p className="text-2xl font-bold text-[#14213D] mt-1">
              {products.length}
            </p>
          </div>
          <div className="p-4 bg-white rounded-xl border border-black/10">
            <p className="text-xs text-[#5A5E6B]">أصحاب القسائم (4+1)</p>
            <p className="text-2xl font-bold text-[#14213D] mt-1">
              {loyaltyCount}
            </p>
          </div>
        </div>

        {statusMessage && (
          <div
            role="status"
            data-testid="admin-status-banner"
            className={`p-3.5 rounded-xl border text-sm flex items-center gap-2.5 ${
              statusTone === 'error'
                ? 'bg-[#FDF2F2] border-[#9E1C28]/30 text-[#9E1C28]'
                : statusTone === 'warning'
                  ? 'bg-[#FDF8EA] border-[#A67C37]/40 text-[#7A5218]'
                  : 'bg-[#F0F7F4] border-[#1E6B52]/25 text-[#17523E]'
            }`}
          >
            {statusTone !== 'success' && (
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            )}
            <span>{statusMessage}</span>
          </div>
        )}

        {/* Admin Tabs */}
        <div
          role="tablist"
          aria-label="أقسام لوحة الإدارة"
          className="flex flex-wrap gap-2"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'orders'}
            onClick={() => setActiveTab('orders')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg cursor-pointer ${
              activeTab === 'orders'
                ? 'bg-[#14213D] text-white'
                : 'bg-[#F2EFE9] text-[#3B3F4A] hover:bg-[#E5E0D5]'
            }`}
          >
            <Package className="w-4 h-4" aria-hidden="true" />
            <span>استلام الطلبات ({orders.length})</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'notifications'}
            onClick={() => setActiveTab('notifications')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg cursor-pointer ${
              activeTab === 'notifications'
                ? 'bg-[#6B1D2F] text-white'
                : 'bg-[#F2EFE9] text-[#3B3F4A] hover:bg-[#E5E0D5]'
            }`}
          >
            <Bell className="w-4 h-4" aria-hidden="true" />
            <span>
              إشعارات المالك ({unreadNotificationsCount > 0 ? unreadNotificationsCount : notifications.length})
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'custom_requests'}
            onClick={() => setActiveTab('custom_requests')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg cursor-pointer ${
              activeTab === 'custom_requests'
                ? 'bg-[#14213D] text-white'
                : 'bg-[#F2EFE9] text-[#3B3F4A] hover:bg-[#E5E0D5]'
            }`}
          >
            <Sparkles className="w-4 h-4" aria-hidden="true" />
            <span>طلبات وفرلي عطري ({customRequests.length})</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'products'}
            onClick={() => setActiveTab('products')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg cursor-pointer ${
              activeTab === 'products'
                ? 'bg-[#14213D] text-white'
                : 'bg-[#F2EFE9] text-[#3B3F4A] hover:bg-[#E5E0D5]'
            }`}
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>العطور والأسعار</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'promo_codes'}
            onClick={() => setActiveTab('promo_codes')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg cursor-pointer ${
              activeTab === 'promo_codes'
                ? 'bg-[#14213D] text-white'
                : 'bg-[#F2EFE9] text-[#3B3F4A] hover:bg-[#E5E0D5]'
            }`}
          >
            <Tag className="w-4 h-4" aria-hidden="true" />
            <span>أكواد الخصم ({promoCodes.length})</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'social'}
            onClick={() => setActiveTab('social')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg cursor-pointer ${
              activeTab === 'social'
                ? 'bg-[#14213D] text-white'
                : 'bg-[#F2EFE9] text-[#3B3F4A] hover:bg-[#E5E0D5]'
            }`}
          >
            <Share2 className="w-4 h-4" aria-hidden="true" />
            <span>مواقع التواصل</span>
          </button>
        </div>

        {/* TAB 1: ORDERS INBOX WITH LIVE STATUS, ARRIVAL TIME & WHATSAPP NOTIFY */}
        {activeTab === 'orders' && (
          <section className="space-y-4">
            {orders.length === 0 ? (
              <div className="p-12 text-center bg-white rounded-2xl border border-black/10 text-[#5A5E6B]">
                لا توجد طلبات شراء مستلمة حتى الآن.
              </div>
            ) : (
              orders.map((order) => {
                const draft = getOrderDraft(order);
                const whatsappHref = buildWhatsAppUrl(
                  order.phone,
                  buildCustomerStatusWhatsAppText({
                    ...order,
                    status: draft.status,
                    estimatedArrival: draft.estimatedArrival,
                    statusMessage: draft.statusMessage,
                  })
                );

                return (
                  <article
                    key={order.id}
                    className="bg-white rounded-2xl border border-black/10 p-6 space-y-4"
                  >
                    <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 pb-4 border-b border-black/10">
                      <div className="space-y-1">
                        <p className="text-xs font-bold text-[#6B1D2F] tabular-nums">
                          {order.orderNumber} · قسيمة {order.voucherCode} · وقت
                          الطلب: {formatArabicDateTime(order.createdAt)}
                        </p>
                        <h3 className="text-lg font-bold text-[#14213D]">
                          {order.fullName}
                        </h3>
                        <p className="text-xs text-[#5A5E6B]">
                          الهاتف:{' '}
                          <span dir="ltr" className="tabular-nums font-semibold">
                            {order.phone}
                          </span>{' '}
                          · الميلاد:{' '}
                          <span className="tabular-nums">{order.birthDate}</span>
                        </p>
                        <p className="text-xs text-[#454954]">
                          الموقع بالتحديد: {order.exactLocation}
                        </p>
                        {order.deliveredAt && (
                          <p className="text-xs font-semibold text-[#17523E]">
                            تم التسليم للزبون في:{' '}
                            {formatArabicDateTime(order.deliveredAt)}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-col items-start md:items-end gap-2 shrink-0">
                        <span className="text-xs font-bold text-[#14213D] bg-[#F2EFE9] px-3 py-1.5 rounded-lg">
                          الحالة الحالية: {order.status}
                        </span>
                        <a
                          href={whatsappHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#1E6B52] hover:bg-[#17523E] rounded-lg transition-colors"
                        >
                          <MessageCircle className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>إبلاغ الزبون عبر واتساب</span>
                        </a>
                      </div>
                    </div>

                    {/* Order Tracking Control Panel (Status + Arrival Time + Customer Message) */}
                    <div className="p-4 rounded-xl bg-[#FAF8F5] border border-black/10 space-y-3">
                      <p className="text-xs font-bold text-[#14213D]">
                        تحديث حالة الطلب ووقت الوصول (يظهر فوراً للزبون في تتبع الطلب):
                      </p>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div>
                          <label
                            htmlFor={`status-${order.id}`}
                            className="block text-[11px] font-semibold text-[#5A5E6B] mb-1"
                          >
                            مرحلة الطلب
                          </label>
                          <select
                            id={`status-${order.id}`}
                            value={draft.status}
                            onChange={(e) =>
                              updateOrderDraft(order, {
                                status: e.target.value as OrderStatus,
                              })
                            }
                            className="w-full ps-3 pe-8 py-2 text-sm font-semibold bg-white border border-black/15 rounded-lg"
                          >
                            <option value="تم الاستلام">تم الاستلام</option>
                            <option value="قيد المراجعة">قيد المراجعة</option>
                            <option value="تم التجهيز">تم التجهيز</option>
                            <option value="قيد التوصيل">قيد التوصيل</option>
                            <option value="تم التسليم">تم التسليم</option>
                          </select>
                        </div>

                        <div>
                          <label
                            htmlFor={`arrival-${order.id}`}
                            className="block text-[11px] font-semibold text-[#5A5E6B] mb-1"
                          >
                            وقت الوصول المتوقع
                          </label>
                          <input
                            id={`arrival-${order.id}`}
                            type="text"
                            value={draft.estimatedArrival}
                            onChange={(e) =>
                              updateOrderDraft(order, {
                                estimatedArrival: e.target.value,
                              })
                            }
                            placeholder="مثال: اليوم الساعة 5:00 عصراً"
                            className="w-full px-3 py-2 text-sm bg-white border border-black/15 rounded-lg"
                          />
                        </div>

                        <div>
                          <label
                            htmlFor={`note-${order.id}`}
                            className="block text-[11px] font-semibold text-[#5A5E6B] mb-1"
                          >
                            رسالة التحديث للزبون
                          </label>
                          <input
                            id={`note-${order.id}`}
                            type="text"
                            value={draft.statusMessage}
                            onChange={(e) =>
                              updateOrderDraft(order, {
                                statusMessage: e.target.value,
                              })
                            }
                            placeholder="اكتب ملاحظة تظهر للزبون..."
                            className="w-full px-3 py-2 text-sm bg-white border border-black/15 rounded-lg"
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 text-[11px] text-[#5A5E6B]">
                            <Clock className="w-3 h-3" aria-hidden="true" />
                            <span>تحديد سريع للوقت:</span>
                          </span>
                          {ARRIVAL_PRESETS.map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              onClick={() =>
                                updateOrderDraft(order, {
                                  estimatedArrival: preset,
                                })
                              }
                              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md cursor-pointer ${
                                draft.estimatedArrival === preset
                                  ? 'bg-[#14213D] text-white'
                                  : 'bg-white border border-black/10 text-[#3B3F4A] hover:bg-[#F2EFE9]'
                              }`}
                            >
                              {preset}
                            </button>
                          ))}
                        </div>

                        <button
                          type="button"
                          disabled={savingOrderId === order.id}
                          onClick={() => handleSaveOrderUpdate(order)}
                          className="px-4 py-2 text-xs font-bold text-white bg-[#6B1D2F] hover:bg-[#531523] disabled:opacity-50 rounded-lg cursor-pointer"
                        >
                          {savingOrderId === order.id
                            ? 'جاري الحفظ...'
                            : 'حفظ وإرسال التحديث للزبون'}
                        </button>
                      </div>
                    </div>

                    <ul className="space-y-1.5 text-sm">
                      {order.items.map((item, idx) => (
                        <li
                          key={`${order.id}-${item.productId}-${idx}`}
                          className="flex justify-between text-[#3B3F4A] tabular-nums"
                        >
                          <span>
                            #{item.code} {item.name} ({item.brand}
                            {item.size ? ` · ${item.size}` : ''}) ×{' '}
                            {item.quantity}
                            {item.includesFreeTester ? ' + تيستر مجاني' : ''}
                          </span>
                          <span>{formatIQD(item.priceIqd * item.quantity)}</span>
                        </li>
                      ))}
                    </ul>

                    <div className="pt-3 border-t border-black/10 flex flex-wrap items-center justify-between gap-4 text-sm tabular-nums">
                      <span className="text-[#5A5E6B]">
                        التيسترات المجانية: {order.pricing.freeTestersCount} ·
                        خصم القسيمة: {formatIQD(order.pricing.loyaltyDiscountIqd)}
                        {order.pricing.promoDiscountIqd > 0 &&
                        order.pricing.promoCode
                          ? ` · بروموكود ${order.pricing.promoCode} (${order.pricing.promoOwnerName}): -${formatIQD(order.pricing.promoDiscountIqd)}`
                          : ''}{' '}
                        · التوصيل:{' '}
                        {order.pricing.qualifiesForFreeDelivery
                          ? 'مجاني'
                          : formatIQD(order.pricing.deliveryFeeIqd)}
                      </span>
                      <span className="font-bold text-[#14213D] text-base">
                        الإجمالي: {formatIQD(order.pricing.totalIqd)}
                      </span>
                    </div>
                  </article>
                );
              })
            )}
          </section>
        )}

        {/* TAB 2: OWNER NOTIFICATIONS & INSTANT PHONE ALERTS */}
        {activeTab === 'notifications' && (
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left Column: Live Browser Sound + Telegram Instant Phone Push Setup */}
            <div className="lg:col-span-5 space-y-6">
              <div className="bg-white rounded-2xl border border-black/10 p-6 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-display text-xl font-bold text-[#14213D]">
                    التنبيهات الفورية داخل لوحة التحكم
                  </h2>
                  <span className="text-xs font-semibold text-[#17523E]">
                    {liveStreamConnected ? 'متصل مباشرة' : 'جاري الاتصال...'}
                  </span>
                </div>
                <p className="text-xs text-[#5A5E6B] leading-relaxed">
                  بمجرد أن يكمل أي زبون طلبه تصلك رسالة فورية هنا مع تنبيه صوتي
                  وإشعار متصفح لتبدأ بتجهيز العطر فوراً.
                </p>
                <div className="flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      const next = !soundEnabled;
                      setSoundEnabled(next);
                      if (next) playNotificationChime();
                    }}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg cursor-pointer ${
                      soundEnabled
                        ? 'bg-[#14213D] text-white'
                        : 'bg-[#F2EFE9] text-[#3B3F4A]'
                    }`}
                  >
                    {soundEnabled ? (
                      <Volume2 className="w-4 h-4" aria-hidden="true" />
                    ) : (
                      <VolumeX className="w-4 h-4" aria-hidden="true" />
                    )}
                    <span>
                      {soundEnabled ? 'الصوت الفوري مفعّل' : 'تشغيل صوت التنبيه'}
                    </span>
                  </button>

                  {browserNotifPermission !== 'unsupported' && (
                    <button
                      type="button"
                      onClick={handleRequestBrowserNotifications}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-[#F2EFE9] hover:bg-[#E5E0D5] text-[#14213D] rounded-lg cursor-pointer"
                    >
                      <BellRing className="w-4 h-4" aria-hidden="true" />
                      <span>
                        {browserNotifPermission === 'granted'
                          ? 'إشعارات المتصفح مفعّلة'
                          : 'تفعيل إشعارات المتصفح'}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {/* Telegram Bot Instant Phone Push */}
              <form
                onSubmit={handleSaveTelegramConfig}
                className="bg-white rounded-2xl border border-black/10 p-6 space-y-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-display text-xl font-bold text-[#14213D]">
                    إشعارات الهاتف الفورية عبر تيليغرام
                  </h2>
                  {telegramStatus.configured && (
                    <span className="text-xs font-bold text-[#17523E] bg-[#F0F7F4] px-2.5 py-1 rounded-md">
                      مربوط ({telegramStatus.chatIdMasked})
                    </span>
                  )}
                </div>

                <p className="text-xs text-[#5A5E6B] leading-relaxed">
                  تُحفظ بيانات البوت مباشرة على خادم الموقع لتصلك إشعارات الطلبات
                  على هاتفك فوراً{' '}
                  <strong className="text-[#14213D]">
                    حتى عند إغلاق الموقع وشاشة الهاتف بالكامل (24/7)
                  </strong>
                  . أنشئ بوت مجاني عبر{' '}
                  <span dir="ltr" className="font-semibold">
                    @BotFather
                  </span>{' '}
                  وأدخل التوكن ورقم{' '}
                  <span dir="ltr" className="font-semibold">
                    Chat ID
                  </span>{' '}
                  الخاص بك (وأرسل{' '}
                  <span dir="ltr" className="font-semibold">
                    /start
                  </span>{' '}
                  للبوت مرة واحدة، ويمكنك أيضاً حفظهما في أسرار الخادم{' '}
                  <span dir="ltr" className="font-semibold">
                    TELEGRAM_BOT_TOKEN
                  </span>{' '}
                  و{' '}
                  <span dir="ltr" className="font-semibold">
                    TELEGRAM_CHAT_ID
                  </span>
                  ).
                </p>

                <div>
                  <label
                    htmlFor="tg-token"
                    className="block text-xs font-semibold text-[#14213D] mb-1"
                  >
                    Bot Token
                  </label>
                  <input
                    id="tg-token"
                    type="password"
                    dir="ltr"
                    required
                    value={tgBotToken}
                    onChange={(e) => setTgBotToken(e.target.value)}
                    placeholder="123456789:AAH..."
                    className="w-full px-3 py-2 text-xs bg-[#FAF8F5] border border-black/15 rounded-lg"
                  />
                </div>

                <div>
                  <label
                    htmlFor="tg-chat-id"
                    className="block text-xs font-semibold text-[#14213D] mb-1"
                  >
                    Chat ID
                  </label>
                  <input
                    id="tg-chat-id"
                    type="text"
                    dir="ltr"
                    required
                    value={tgChatId}
                    onChange={(e) => setTgChatId(e.target.value)}
                    placeholder="123456789"
                    className="w-full px-3 py-2 text-xs bg-[#FAF8F5] border border-black/15 rounded-lg"
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    disabled={tgBusy}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] rounded-lg cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      {telegramStatus.configured
                        ? 'تحديث الربط'
                        : 'حفظ وربط تيليغرام'}
                    </span>
                  </button>

                  {telegramStatus.configured && (
                    <>
                      <button
                        type="button"
                        disabled={tgBusy}
                        onClick={handleTestTelegram}
                        className="px-3.5 py-2 text-xs font-semibold bg-[#F2EFE9] hover:bg-[#E5E0D5] text-[#14213D] rounded-lg cursor-pointer"
                      >
                        إرسال رسالة اختبار
                      </button>
                      <button
                        type="button"
                        disabled={tgBusy}
                        onClick={handleDeleteTelegramConfig}
                        className="px-3.5 py-2 text-xs font-semibold text-[#9E1C28] hover:bg-[#FDF2F2] rounded-lg cursor-pointer"
                      >
                        إلغاء الربط
                      </button>
                    </>
                  )}
                </div>
              </form>
            </div>

            {/* Right Column: Notifications Inbox */}
            <div className="lg:col-span-7 bg-white rounded-2xl border border-black/10 overflow-hidden">
              <div className="px-6 py-4 border-b border-black/10 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-xl font-bold text-[#14213D]">
                  سجل رسائل الطلبات الواردة ({notifications.length})
                </h2>
                {unreadNotificationsCount > 0 && (
                  <button
                    type="button"
                    onClick={handleMarkAllNotificationsRead}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#F2EFE9] hover:bg-[#E5E0D5] text-[#14213D] rounded-lg cursor-pointer"
                  >
                    <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>تعليم الكل كمقروء</span>
                  </button>
                )}
              </div>

              {notifications.length === 0 ? (
                <div className="p-12 text-center text-sm text-[#5A5E6B]">
                  لم تصلك إشعارات بعد. بمجرد تقديم أي زبون لطلب جديد ستظهر رسالته
                  هنا فوراً.
                </div>
              ) : (
                <div className="divide-y divide-black/10">
                  {notifications.map((notif) => (
                    <article
                      key={notif.id}
                      className={`p-5 space-y-2.5 ${
                        notif.read ? 'bg-white' : 'bg-[#FAF6EE]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-[#6B1D2F]">
                            {notif.type === 'new_order'
                              ? `طلب شراء جديد ${notif.orderNumber ?? ''}`
                              : 'طلب «وفرلي عطري»'}
                          </span>
                          {!notif.read && (
                            <span className="text-[11px] font-bold text-[#9E1C28]">
                              · جديد
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-[#5A5E6B] tabular-nums">
                          {formatArabicDateTime(notif.createdAt)}
                        </span>
                      </div>

                      <p className="text-sm font-bold text-[#14213D]">
                        {notif.customerName} ·{' '}
                        <span dir="ltr" className="tabular-nums font-semibold">
                          {notif.customerPhone}
                        </span>
                      </p>

                      {notif.exactLocation && (
                        <p className="text-xs text-[#454954]">
                          الموقع: {notif.exactLocation}
                        </p>
                      )}

                      <p className="text-xs text-[#3B3F4A]">
                        المنتجات: {notif.itemsSummary}
                        {typeof notif.totalIqd === 'number'
                          ? ` — الإجمالي: ${formatIQD(notif.totalIqd)}`
                          : ''}
                      </p>

                      <div className="flex flex-wrap gap-2 pt-1">
                        {notif.type === 'new_order' ? (
                          <button
                            type="button"
                            onClick={() => setActiveTab('orders')}
                            className="px-3 py-1.5 text-xs font-semibold bg-[#14213D] hover:bg-[#6B1D2F] text-white rounded-lg cursor-pointer"
                          >
                            مراجعة وتجهيز الطلب
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setActiveTab('custom_requests')}
                            className="px-3 py-1.5 text-xs font-semibold bg-[#14213D] hover:bg-[#6B1D2F] text-white rounded-lg cursor-pointer"
                          >
                            فتح طلبات «وفرلي عطري»
                          </button>
                        )}
                        <a
                          href={buildWhatsAppUrl(
                            notif.customerPhone,
                            `مرحباً ${notif.customerName}، بخصوص طلبك من وكالة بلوكرانا للعطور (${notif.orderNumber ?? notif.itemsSummary})...`
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-[#F2EFE9] hover:bg-[#E5E0D5] text-[#14213D] rounded-lg"
                        >
                          <MessageCircle
                            className="w-3.5 h-3.5"
                            aria-hidden="true"
                          />
                          <span>مراسلة الزبون واتساب</span>
                        </a>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* TAB 3: CUSTOM PERFUME REQUESTS */}
        {activeTab === 'custom_requests' && (
          <section className="space-y-4">
            {customRequests.length === 0 ? (
              <div className="p-12 text-center bg-white rounded-2xl border border-black/10 text-[#5A5E6B]">
                لا توجد طلبات «وفرلي عطري» حتى الآن.
              </div>
            ) : (
              customRequests.map((req) => (
                <article
                  key={req.id}
                  className="bg-white rounded-2xl border border-black/10 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-[#6B1D2F]">
                      طلب توفير عطر خاص
                    </p>
                    <h3 className="text-lg font-bold text-[#14213D]">
                      {req.perfumeName} — {req.size}
                    </h3>
                    <p className="text-sm text-[#454954] tabular-nums">
                      السعر المتوقع: {formatIQD(req.expectedPriceIqd)} · موعد
                      التوصيل المطلوب: {req.desiredDate}
                    </p>
                    <p className="text-xs text-[#5A5E6B]">
                      الزبون: {req.customerName} · الهاتف:{' '}
                      <span dir="ltr" className="tabular-nums">
                        {req.customerPhone}
                      </span>
                      {req.notes ? ` · ملاحظات: ${req.notes}` : ''}
                    </p>
                  </div>

                  <select
                    aria-label={`تحديث حالة طلب ${req.perfumeName}`}
                    value={req.status}
                    onChange={(e) =>
                      handleCustomStatusChange(
                        req.id,
                        e.target.value as CustomRequestStatus
                      )
                    }
                    className="ps-3 pe-8 py-2 text-sm font-semibold bg-[#FAF8F5] border border-black/15 rounded-lg shrink-0"
                  >
                    <option value="قيد البحث">قيد البحث</option>
                    <option value="تم التوفير">تم التوفير</option>
                    <option value="تم التواصل">تم التواصل</option>
                  </select>
                </article>
              ))
            )}
          </section>
        )}

        {/* TAB 3: PRODUCTS CRUD + BULK PRICING + IMAGE UPLOAD + BULK IMPORT */}
        {activeTab === 'products' && (
          <section className="space-y-8">
            <FirestoreMigrationPanel
              storeInfo={storeInfo}
              products={products}
              socialLinks={socialLinks}
              onMigrationCompleted={onCatalogMutated}
            />

            <FirestoreBackupPanel
              onBeforeSyncLocalBackup={async (restored: BackupRestoreResult) => {
                const prevById = new Map(products.map((p) => [p.id, p]));
                const restoredById = new Map(
                  restored.products.map((p) => [p.id, p])
                );
                const addedProducts = restored.products.filter(
                  (p) => !prevById.has(p.id)
                );
                const updatedProducts = restored.products.filter((p) =>
                  prevById.has(p.id)
                );
                const deletedIds = products
                  .filter((p) => !restoredById.has(p.id))
                  .map((p) => p.id);

                if (addedProducts.length > 0) {
                  recordOwnerAddedProducts(addedProducts);
                }
                if (updatedProducts.length > 0) {
                  recordOwnerUpdatedProducts(updatedProducts);
                }
                for (const delId of deletedIds) {
                  recordOwnerDeletedProduct(delId);
                }

                if (!token) return false;
                try {
                  const res = await fetch(apiUrl('/api/admin/save-all'), {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                      addedProducts,
                      updatedProducts,
                      deletedIds,
                      socialLinks: restored.socialLinks,
                    }),
                  });
                  return res.ok;
                } catch {
                  return false;
                }
              }}
              onRestoreCompleted={async (restored: BackupRestoreResult) => {
                setProducts(restored.products);
                setSocialLinks(restored.socialLinks);
                setPendingProductEdits({});
                await onCatalogMutated();
              }}
              onStatusBanner={setBannerStatus}
            />

            {!isFirestoreOwnerVerified && (
              <div
                role="status"
                className="p-3.5 rounded-xl bg-[#FDFBF7] border border-[#A67C37]/40 text-xs text-[#6B1D2F] flex items-center gap-2"
              >
                <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>
                  لحفظ أي إضافة أو تعديل أو حذف للعطور مباشرة في قاعدة{' '}
                  <strong className="font-semibold">Firestore</strong>، يرجى تسجيل
                  دخول Google أعلاه بالحساب الموثق ({AUTHORIZED_ADMIN_EMAIL}).
                </span>
              </div>
            )}

            {statusMessage && (
              <div
                role="status"
                data-testid="admin-products-status-banner"
                className={`p-3.5 rounded-xl border text-xs sm:text-sm flex items-center gap-2.5 ${
                  statusTone === 'error'
                    ? 'bg-[#FDF2F2] border-[#9E1C28]/30 text-[#9E1C28]'
                    : statusTone === 'warning'
                      ? 'bg-[#FDF8EA] border-[#A67C37]/40 text-[#7A5218]'
                      : 'bg-[#F0F7F4] border-[#1E6B52]/25 text-[#17523E]'
                }`}
              >
                {statusTone !== 'success' && (
                  <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                )}
                <span>{statusMessage}</span>
              </div>
            )}

            {/* Bulk Price Management Bar */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Blaugrana 3-size global pricing */}
              <form
                onSubmit={handleBulkBlaugranaSizePrices}
                className="bg-white rounded-2xl border border-black/10 p-6 space-y-4"
              >
                <div className="flex items-center gap-2">
                  <Coins className="w-5 h-5 text-[#A67C37]" aria-hidden="true" />
                  <h2 className="font-display text-xl font-bold text-[#14213D]">
                    تحديث أسعار أحجام عطور بلوكرانا (دفعة واحدة)
                  </h2>
                </div>
                <p className="text-xs text-[#5A5E6B] leading-relaxed">
                  عدّل سعر الـ 30 مل و50 مل و100 مل وسيتم تطبيقه مباشرة على جميع
                  عطور وكالة بلوكرانا المرقمة.
                </p>
                <div className="grid grid-cols-3 gap-3 tabular-nums">
                  <div>
                    <label
                      htmlFor="bulk-30"
                      className="block text-xs font-semibold text-[#14213D] mb-1"
                    >
                      سعر 30 مل (د.ع)
                    </label>
                    <input
                      id="bulk-30"
                      type="number"
                      min="500"
                      required
                      value={bulkPrice30}
                      onChange={(e) => setBulkPrice30(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="bulk-50"
                      className="block text-xs font-semibold text-[#14213D] mb-1"
                    >
                      سعر 50 مل (د.ع)
                    </label>
                    <input
                      id="bulk-50"
                      type="number"
                      min="500"
                      required
                      value={bulkPrice50}
                      onChange={(e) => setBulkPrice50(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="bulk-100"
                      className="block text-xs font-semibold text-[#14213D] mb-1"
                    >
                      سعر 100 مل (د.ع)
                    </label>
                    <input
                      id="bulk-100"
                      type="number"
                      min="500"
                      required
                      value={bulkPrice100}
                      onChange={(e) => setBulkPrice100(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={bulkPriceBusy}
                  className="w-full py-2.5 px-4 text-xs sm:text-sm font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] disabled:opacity-50 rounded-lg cursor-pointer"
                >
                  تطبيق الأسعار على جميع عطور بلوكرانا
                </button>
              </form>

              {/* All / Category Bulk Price Adjuster */}
              <form
                onSubmit={handleBulkCategoryPriceAdjust}
                className="bg-white rounded-2xl border border-black/10 p-6 space-y-4"
              >
                <div className="flex items-center gap-2">
                  <Coins className="w-5 h-5 text-[#6B1D2F]" aria-hidden="true" />
                  <h2 className="font-display text-xl font-bold text-[#14213D]">
                    تغيير الأسعار لجميع العطور أو حسب القسم
                  </h2>
                </div>
                <p className="text-xs text-[#5A5E6B] leading-relaxed">
                  يمكنك زيادة أو تخفيض الأسعار بنسبة مئوية أو بمبلغ ثابت أو
                  توحيد السعر لقسم كامل أو لجميع منتجات المتجر.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label
                      htmlFor="bulk-cat"
                      className="block text-xs font-semibold text-[#14213D] mb-1"
                    >
                      القسم المستهدف
                    </label>
                    <select
                      id="bulk-cat"
                      value={bulkCategory}
                      onChange={(e) =>
                        setBulkCategory(
                          e.target.value as 'all' | ProductCategory
                        )
                      }
                      className="w-full ps-3 pe-8 py-2 text-xs sm:text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                    >
                      <option value="all">جميع العطور والمنتجات</option>
                      {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="bulk-type"
                      className="block text-xs font-semibold text-[#14213D] mb-1"
                    >
                      طريقة التعديل
                    </label>
                    <select
                      id="bulk-type"
                      value={bulkAdjustType}
                      onChange={(e) =>
                        setBulkAdjustType(
                          e.target.value as
                            | 'percent'
                            | 'fixed_price'
                            | 'fixed_delta'
                        )
                      }
                      className="w-full ps-3 pe-8 py-2 text-xs sm:text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                    >
                      <option value="fixed_delta">إضافة/طرح مبلغ (د.ع)</option>
                      <option value="percent">نسبة مئوية (+ أو - %)</option>
                      <option value="fixed_price">توحيد السعر (د.ع)</option>
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="bulk-val"
                      className="block text-xs font-semibold text-[#14213D] mb-1"
                    >
                      القيمة
                    </label>
                    <input
                      id="bulk-val"
                      type="number"
                      required
                      value={bulkAdjustValue}
                      onChange={(e) => setBulkAdjustValue(e.target.value)}
                      placeholder={
                        bulkAdjustType === 'percent'
                          ? 'مثال: 10 أو -10'
                          : bulkAdjustType === 'fixed_price'
                            ? 'مثال: 20000'
                            : 'مثال: 2000 أو -2000'
                      }
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-[#FAF8F5] border border-black/15 rounded-lg tabular-nums"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={bulkPriceBusy}
                  className="w-full py-2.5 px-4 text-xs sm:text-sm font-semibold text-white bg-[#6B1D2F] hover:bg-[#531523] disabled:opacity-50 rounded-lg cursor-pointer"
                >
                  تنفيذ تغيير الأسعار الجماعي
                </button>
              </form>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* Add / Edit Single Product + Bulk Add */}
              <div className="lg:col-span-5 space-y-6">
                <form
                  ref={productFormRef}
                  onSubmit={handleProductSubmit}
                  className="bg-white rounded-2xl border border-black/10 p-6 space-y-4"
                >
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-2xl font-bold text-[#14213D]">
                      {editingProductId
                        ? 'تعديل العطر وصورته وسعره'
                        : 'إضافة عطر أو منتج جديد'}
                    </h2>
                    {editingProductId && (
                      <button
                        type="button"
                        onClick={resetProductForm}
                        className="text-xs text-[#6B1D2F] underline cursor-pointer"
                      >
                        إلغاء التعديل
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="p-code"
                        className="block text-xs font-semibold text-[#14213D] mb-1"
                      >
                        رقم العطر
                      </label>
                      <input
                        id="p-code"
                        type="text"
                        required
                        value={pCode}
                        onChange={(e) => setPCode(e.target.value)}
                        placeholder="M66"
                        className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg tabular-nums"
                      />
                    </div>
                    {pCategory === 'blaugrana' ? (
                      <div>
                        <label
                          htmlFor="p-price-100"
                          className="block text-xs font-semibold text-[#14213D] mb-1"
                        >
                          سعر 100 مل (د.ع)
                        </label>
                        <input
                          id="p-price-100"
                          type="number"
                          required
                          min="500"
                          value={pPrice100}
                          onChange={(e) => {
                            setPPrice100(e.target.value);
                            setPPrice(e.target.value);
                          }}
                          placeholder="30000"
                          className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg tabular-nums"
                        />
                      </div>
                    ) : (
                      <div>
                        <label
                          htmlFor="p-price"
                          className="block text-xs font-semibold text-[#14213D] mb-1"
                        >
                          السعر (د.ع)
                        </label>
                        <input
                          id="p-price"
                          type="number"
                          required
                          min="500"
                          value={pPrice}
                          onChange={(e) => setPPrice(e.target.value)}
                          placeholder="25000"
                          className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg tabular-nums"
                        />
                      </div>
                    )}
                  </div>

                  {pCategory === 'blaugrana' && (
                    <div className="grid grid-cols-2 gap-3 p-3 rounded-xl bg-[#FAF8F5] border border-black/10 tabular-nums">
                      <div>
                        <label
                          htmlFor="p-price-30"
                          className="block text-[11px] font-semibold text-[#14213D] mb-1"
                        >
                          سعر حجم 30 مل (د.ع)
                        </label>
                        <input
                          id="p-price-30"
                          type="number"
                          min="500"
                          required
                          value={pPrice30}
                          onChange={(e) => setPPrice30(e.target.value)}
                          className="w-full px-3 py-1.5 text-sm bg-white border border-black/15 rounded-lg"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="p-price-50"
                          className="block text-[11px] font-semibold text-[#14213D] mb-1"
                        >
                          سعر حجم 50 مل (د.ع)
                        </label>
                        <input
                          id="p-price-50"
                          type="number"
                          min="500"
                          required
                          value={pPrice50}
                          onChange={(e) => setPPrice50(e.target.value)}
                          className="w-full px-3 py-1.5 text-sm bg-white border border-black/15 rounded-lg"
                        />
                      </div>
                    </div>
                  )}

                <div>
                  <label
                    htmlFor="p-name"
                    className="block text-xs font-semibold text-[#14213D] mb-1"
                  >
                    اسم العطر / المنتج
                  </label>
                  <input
                    id="p-name"
                    type="text"
                    required
                    value={pName}
                    onChange={(e) => setPName(e.target.value)}
                    placeholder="مثال: بلوكرانا مسك النخبة"
                    className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="p-category"
                      className="block text-xs font-semibold text-[#14213D] mb-1"
                    >
                      التصنيف (الخانة)
                    </label>
                    <select
                      id="p-category"
                      value={pCategory}
                      onChange={(e) =>
                        setPCategory(e.target.value as ProductCategory)
                      }
                      className="w-full ps-3 pe-8 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                    >
                      {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="p-brand"
                      className="block text-xs font-semibold text-[#14213D] mb-1"
                    >
                      الشركة / العلامة
                    </label>
                    <input
                      id="p-brand"
                      type="text"
                      value={pBrand}
                      onChange={(e) => setPBrand(e.target.value)}
                      placeholder="بلوكرانا أو شركة أخرى"
                      className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label
                      htmlFor="p-size"
                      className="block text-xs font-semibold text-[#14213D] mb-1"
                    >
                      الحجم
                    </label>
                    <input
                      id="p-size"
                      type="text"
                      value={pSize}
                      onChange={(e) => setPSize(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="p-longevity"
                      className="block text-xs font-semibold text-[#14213D] mb-1"
                    >
                      الثبات
                    </label>
                    <input
                      id="p-longevity"
                      type="text"
                      value={pLongevity}
                      onChange={(e) => setPLongevity(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="p-sillage"
                      className="block text-xs font-semibold text-[#14213D] mb-1"
                    >
                      الفوحان
                    </label>
                    <input
                      id="p-sillage"
                      type="text"
                      value={pSillage}
                      onChange={(e) => setPSillage(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                    />
                  </div>
                </div>

                {/* Structured Olfactory Notes */}
                <div className="p-3.5 rounded-xl bg-[#FAF8F5] border border-black/10 space-y-2.5">
                  <p className="text-xs font-bold text-[#6B1D2F]">
                    النوتات العطرية (الهرم العطري)
                  </p>
                  <div>
                    <label
                      htmlFor="p-top-notes"
                      className="block text-[11px] font-semibold text-[#14213D] mb-1"
                    >
                      النوتات العليا (الافتتاحية)
                    </label>
                    <input
                      id="p-top-notes"
                      type="text"
                      value={pTopNotes}
                      onChange={(e) => setPTopNotes(e.target.value)}
                      placeholder="مثال: البرغموت، الليمون الإيطالي"
                      className="w-full px-3 py-1.5 text-xs bg-white border border-black/15 rounded-lg"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="p-heart-notes"
                      className="block text-[11px] font-semibold text-[#14213D] mb-1"
                    >
                      النوتات الوسطى (قلب العطر)
                    </label>
                    <input
                      id="p-heart-notes"
                      type="text"
                      value={pHeartNotes}
                      onChange={(e) => setPHeartNotes(e.target.value)}
                      placeholder="مثال: الياسمين، الورد الدمشقي"
                      className="w-full px-3 py-1.5 text-xs bg-white border border-black/15 rounded-lg"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="p-base-notes"
                      className="block text-[11px] font-semibold text-[#14213D] mb-1"
                    >
                      النوتات الأساسية (القاعدة)
                    </label>
                    <input
                      id="p-base-notes"
                      type="text"
                      value={pBaseNotes}
                      onChange={(e) => setPBaseNotes(e.target.value)}
                      placeholder="مثال: المسك، العنبر، خشب الصندل"
                      className="w-full px-3 py-1.5 text-xs bg-white border border-black/15 rounded-lg"
                    />
                  </div>
                </div>

                {/* Image Upload & URL Management */}
                <div className="p-3.5 rounded-xl bg-[#FAF8F5] border border-black/10 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-[#14213D]">
                      صورة العطر (رفع أو رابط مباشر)
                    </span>
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] rounded-lg cursor-pointer">
                      <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>
                        {uploadingFormImage ? 'جاري الرفع...' : 'رفع صورة من الجهاز'}
                      </span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="sr-only"
                        disabled={uploadingFormImage}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          handleFormImageUpload(f);
                        }}
                      />
                    </label>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="w-16 h-16 rounded-lg bg-white border border-black/10 overflow-hidden shrink-0">
                      <SafeImage
                        src={pImageUrl}
                        alt={pName || 'معاينة الصورة'}
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <div className="flex-1 space-y-2 min-w-0">
                      <label htmlFor="p-image-url" className="sr-only">
                        رابط أو مسار الصورة
                      </label>
                      <input
                        id="p-image-url"
                        type="text"
                        dir="ltr"
                        value={pImageUrl}
                        onChange={(e) => setPImageUrl(e.target.value)}
                        placeholder="/uploads/... أو https://..."
                        className="w-full px-3 py-1.5 text-xs bg-white border border-black/15 rounded-lg"
                      />
                      <select
                        aria-label="اختيار صورة جاهزة"
                        value={
                          IMAGE_PRESETS.some((pr) => pr.url === pImageUrl)
                            ? pImageUrl
                            : ''
                        }
                        onChange={(e) => {
                          if (e.target.value) setPImageUrl(e.target.value);
                        }}
                        className="w-full ps-3 pe-8 py-1.5 text-xs bg-white border border-black/15 rounded-lg"
                      >
                        <option value="">أو اختر قالباً جاهزاً...</option>
                        {IMAGE_PRESETS.map((preset) => (
                          <option key={preset.url} value={preset.url}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-6 text-xs font-medium text-[#14213D]">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pFreeTester}
                      onChange={(e) => setPFreeTester(e.target.checked)}
                    />
                    <span>يشمل تيستر مجاني</span>
                  </label>
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pInStock}
                      onChange={(e) => setPInStock(e.target.checked)}
                    />
                    <span>متوفر في المخزون</span>
                  </label>
                </div>

                <button
                  type="submit"
                  disabled={savingProduct}
                  className="w-full py-2.5 px-5 text-sm font-semibold text-white bg-[#6B1D2F] hover:bg-[#531523] disabled:opacity-50 rounded-lg cursor-pointer"
                >
                  {savingProduct
                    ? 'جاري الحفظ...'
                    : editingProductId
                      ? 'حفظ التعديلات'
                      : 'إضافة إلى المتجر'}
                </button>
              </form>

              {/* Quick Bulk Import for Numbered Perfume Lists */}
              <form
                onSubmit={handleBulkAdd}
                className="bg-white rounded-2xl border border-black/10 p-6 space-y-3"
              >
                <h3 className="font-bold text-sm text-[#14213D]">
                  إضافة سريعة لقائمة عطور مرقمة
                </h3>
                <p className="text-xs text-[#5A5E6B]">
                  أضف كل عطر في سطر بالصيغة: الرقم | الاسم | الشركة | السعر |
                  الحجم
                </p>
                <textarea
                  rows={3}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder="M66 | بلوكرانا سيلفر | بلوكرانا | 22000 | 100 مل"
                  className="w-full px-3 py-2 text-xs bg-[#FAF8F5] border border-black/15 rounded-lg"
                />
                <button
                  type="submit"
                  className="w-full py-2 px-4 text-xs font-semibold text-[#14213D] bg-[#F2EFE9] hover:bg-[#E5E0D5] rounded-lg cursor-pointer"
                >
                  استيراد القائمة دفعة واحدة
                </button>
              </form>
            </div>

            {/* Existing Products List */}
            <div className="lg:col-span-7 bg-white rounded-2xl border border-black/10 overflow-hidden">
              <div className="px-6 py-4 border-b border-black/10 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="font-display text-xl font-bold text-[#14213D]">
                    العطور والمنتجات الحالية ({filteredAdminProducts.length})
                  </h2>

                  <div className="flex flex-wrap items-center gap-2">
                    {pendingChangesCount > 0 && (
                      <button
                        type="button"
                        onClick={handleSaveAllChanges}
                        disabled={savingAllChanges}
                        className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold text-white bg-[#1E6B52] hover:bg-[#17523E] disabled:opacity-50 rounded-lg shadow-sm cursor-pointer"
                      >
                        <Save className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>
                          {savingAllChanges
                            ? 'جاري الحفظ...'
                            : `حفظ جميع التغييرات (${pendingChangesCount})`}
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => setProductFilterMode('all')}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${
                        productFilterMode === 'all'
                          ? 'bg-[#14213D] text-white'
                          : 'bg-[#F2EFE9] text-[#3B3F4A]'
                      }`}
                    >
                      الكل ({sortedProducts.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setProductFilterMode('missing_image')}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${
                        productFilterMode === 'missing_image'
                          ? 'bg-[#6B1D2F] text-white'
                          : 'bg-[#F2EFE9] text-[#6B1D2F]'
                      }`}
                    >
                      بدون صورة مخصصة ({missingImageCount})
                    </button>
                  </div>
                </div>

                <div className="relative">
                  <Search
                    className="w-4 h-4 text-[#5A5E6B] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    aria-label="بحث في منتجات الإدارة"
                    value={adminProductSearch}
                    onChange={(e) => setAdminProductSearch(e.target.value)}
                    placeholder="ابحث برقم العطر (مثل M17) أو اسمه لتعديل صورته أو بياناته..."
                    className="w-full pr-9 pl-3 py-2 text-xs bg-[#FAF8F5] border border-black/15 rounded-lg"
                  />
                </div>
              </div>

              <div className="divide-y divide-black/8 max-h-[760px] overflow-y-auto">
                {filteredAdminProducts.map((product) => {
                  const isInlineOpen = inlineImageProductId === product.id;
                  const isPriceOpen = inlinePriceProductId === product.id;
                  const missingPhoto = product.hasCustomImage === false;
                  const sizeOpts = getProductSizeOptions(product);
                  const pendingEdit = pendingProductEdits[product.id];
                  const effectiveImageUrl =
                    pendingEdit?.imageUrl !== undefined
                      ? pendingEdit.imageUrl
                      : product.imageUrl;
                  const hasPendingImageEdit = pendingEdit?.imageUrl !== undefined;

                  return (
                    <div
                      key={product.id}
                      className={`p-4 space-y-3 transition-colors ${
                        hasPendingImageEdit ? 'bg-[#FFFDF5]' : 'hover:bg-[#FAF8F5]'
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`w-12 h-12 rounded-lg bg-white border overflow-hidden shrink-0 ${
                              hasPendingImageEdit
                                ? 'border-[#A67C37] ring-2 ring-[#A67C37]/30'
                                : 'border-black/10'
                            }`}
                          >
                            <SafeImage
                              src={effectiveImageUrl}
                              alt={product.name}
                              className="w-full h-full object-contain"
                            />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs text-[#6B1D2F] font-semibold tabular-nums">
                              #{product.code} · {product.brand} ·{' '}
                              {CATEGORY_LABELS[product.category]}
                              {hasPendingImageEdit && (
                                <span className="mr-2 text-[#17523E]">
                                  · تعديل بانتظار الحفظ
                                </span>
                              )}
                              {missingPhoto && !hasPendingImageEdit && (
                                <span className="mr-2 text-[#9E1C28]">
                                  · بانتظار إضافة صورة
                                </span>
                              )}
                            </p>
                            <p className="text-sm font-bold text-[#12141A] truncate">
                              {product.name}
                            </p>
                            <p className="text-xs text-[#5A5E6B] tabular-nums">
                              {sizeOpts.length > 1
                                ? sizeOpts
                                    .map(
                                      (o) =>
                                        `${o.size}: ${o.priceIqd.toLocaleString('en-US')}`
                                    )
                                    .join(' · ') + ' د.ع'
                                : `${formatIQD(product.priceIqd)} · ${product.size}`}{' '}
                              · {product.inStock ? 'متوفر' : 'غير متوفر'}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center flex-wrap gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              if (isPriceOpen) {
                                setInlinePriceProductId(null);
                              } else {
                                setInlineImageProductId(null);
                                setInlinePriceProductId(product.id);
                                setInlineSinglePrice(String(product.priceIqd));
                                setInlinePrice30(
                                  String(
                                    product.sizePrices?.['30 مل'] ??
                                      BLAUGRANA_DEFAULT_SIZE_PRICES['30 مل']
                                  )
                                );
                                setInlinePrice50(
                                  String(
                                    product.sizePrices?.['50 مل'] ??
                                      BLAUGRANA_DEFAULT_SIZE_PRICES['50 مل']
                                  )
                                );
                                setInlinePrice100(
                                  String(
                                    product.sizePrices?.['100 مل'] ??
                                      product.priceIqd
                                  )
                                );
                              }
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-[#F0F7F4] hover:bg-[#1E6B52] hover:text-white text-[#17523E] rounded-lg cursor-pointer transition-colors"
                          >
                            <Coins className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>تعديل السعر</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              if (isInlineOpen) {
                                setInlineImageProductId(null);
                              } else {
                                setInlinePriceProductId(null);
                                setInlineImageProductId(product.id);
                                setInlineImageUrl(effectiveImageUrl);
                              }
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-[#14213D]/10 hover:bg-[#14213D] hover:text-white text-[#14213D] rounded-lg cursor-pointer transition-colors"
                          >
                            <ImagePlus className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>تعديل الصورة</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => startEditingProduct(product)}
                            className="px-2.5 py-1.5 text-xs font-semibold bg-[#F2EFE9] hover:bg-[#E5E0D5] text-[#14213D] rounded-lg cursor-pointer"
                          >
                            تعديل
                          </button>

                          <button
                            type="button"
                            onClick={() => handleDeleteProduct(product.id)}
                            aria-label={`حذف ${product.name}`}
                            className="p-1.5 text-[#9E1C28] hover:bg-[#FDF2F2] rounded-lg cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Quick Direct Image URL Paste Field (Always Accessible) */}
                      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                        <input
                          type="text"
                          dir="ltr"
                          aria-label={`رابط صورة مباشر لـ ${product.name}`}
                          value={effectiveImageUrl}
                          onChange={(e) => {
                            const val = e.target.value;
                            stageProductImageEdit(product, val);
                            if (inlineImageProductId === product.id) {
                              setInlineImageUrl(val);
                            }
                          }}
                          placeholder="الصق رابط الصورة هنا (https://... أو /assets/...)"
                          className={`flex-1 px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                            hasPendingImageEdit
                              ? 'bg-white border-[#A67C37] text-[#14213D] font-medium'
                              : 'bg-[#FAF8F5] border-black/10 text-[#5A5E6B]'
                          }`}
                        />
                        {hasPendingImageEdit && (
                          <button
                            type="button"
                            onClick={() =>
                              saveInlineProductImage(product, effectiveImageUrl)
                            }
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-[#1E6B52] hover:bg-[#17523E] rounded-lg cursor-pointer shrink-0"
                          >
                            حفظ هذه الصورة
                          </button>
                        )}
                      </div>

                      {isPriceOpen && (
                        <div className="p-3 rounded-xl bg-white border border-[#1E6B52]/30 flex flex-wrap items-end gap-2.5 tabular-nums">
                          {product.category === 'blaugrana' ||
                          Boolean(product.sizePrices) ? (
                            <>
                              <div className="flex-1 min-w-[90px]">
                                <label className="block text-[11px] font-semibold text-[#14213D] mb-1">
                                  30 مل
                                </label>
                                <input
                                  type="number"
                                  min="500"
                                  value={inlinePrice30}
                                  onChange={(e) =>
                                    setInlinePrice30(e.target.value)
                                  }
                                  className="w-full px-2.5 py-1.5 text-xs bg-[#FAF8F5] border border-black/15 rounded-lg"
                                />
                              </div>
                              <div className="flex-1 min-w-[90px]">
                                <label className="block text-[11px] font-semibold text-[#14213D] mb-1">
                                  50 مل
                                </label>
                                <input
                                  type="number"
                                  min="500"
                                  value={inlinePrice50}
                                  onChange={(e) =>
                                    setInlinePrice50(e.target.value)
                                  }
                                  className="w-full px-2.5 py-1.5 text-xs bg-[#FAF8F5] border border-black/15 rounded-lg"
                                />
                              </div>
                              <div className="flex-1 min-w-[90px]">
                                <label className="block text-[11px] font-semibold text-[#14213D] mb-1">
                                  100 مل
                                </label>
                                <input
                                  type="number"
                                  min="500"
                                  value={inlinePrice100}
                                  onChange={(e) =>
                                    setInlinePrice100(e.target.value)
                                  }
                                  className="w-full px-2.5 py-1.5 text-xs bg-[#FAF8F5] border border-black/15 rounded-lg"
                                />
                              </div>
                            </>
                          ) : (
                            <div className="flex-1 min-w-[140px]">
                              <label className="block text-[11px] font-semibold text-[#14213D] mb-1">
                                السعر (د.ع)
                              </label>
                              <input
                                type="number"
                                min="500"
                                value={inlineSinglePrice}
                                onChange={(e) =>
                                  setInlineSinglePrice(e.target.value)
                                }
                                className="w-full px-2.5 py-1.5 text-xs bg-[#FAF8F5] border border-black/15 rounded-lg"
                              />
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => saveInlineProductPrice(product)}
                            className="px-4 py-1.5 text-xs font-semibold text-white bg-[#1E6B52] hover:bg-[#17523E] rounded-lg cursor-pointer min-h-[34px]"
                          >
                            حفظ السعر
                          </button>
                        </div>
                      )}

                      {isInlineOpen && (
                        <div className="p-3 rounded-xl bg-white border border-[#14213D]/20 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                          <label className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] rounded-lg cursor-pointer shrink-0">
                            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>
                              {uploadingInlineImage
                                ? 'جاري الرفع...'
                                : 'اختيار صورة من الجهاز'}
                            </span>
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              className="sr-only"
                              disabled={uploadingInlineImage}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                e.target.value = '';
                                handleInlineImageUpload(product, f);
                              }}
                            />
                          </label>

                          <input
                            type="text"
                            dir="ltr"
                            aria-label={`رابط صورة ${product.name}`}
                            value={inlineImageUrl}
                            onChange={(e) => {
                              setInlineImageUrl(e.target.value);
                              stageProductImageEdit(product, e.target.value);
                            }}
                            placeholder="أو الصق رابط الصورة هنا..."
                            className="flex-1 px-3 py-2 text-xs bg-[#FAF8F5] border border-black/15 rounded-lg"
                          />

                          <button
                            type="button"
                            onClick={() =>
                              saveInlineProductImage(product, inlineImageUrl)
                            }
                            className="px-4 py-2 text-xs font-semibold text-white bg-[#6B1D2F] hover:bg-[#531523] rounded-lg cursor-pointer shrink-0"
                          >
                            حفظ الصورة
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            </div>

            {pendingChangesCount > 0 && (
              <div
                role="region"
                aria-label="شريط حفظ جميع التغييرات"
                className="sticky bottom-4 z-40 mx-auto max-w-2xl rounded-2xl bg-[#14213D] text-white px-5 py-3.5 shadow-xl border border-[#A67C37]/40 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2.5 text-xs sm:text-sm">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#A67C37] shrink-0" />
                  <span className="font-semibold">
                    لديك {pendingChangesCount} تعديل بانتظار الحفظ في الكتالوج
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDiscardAllChanges}
                    disabled={savingAllChanges}
                    className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold text-[#E5DFD3] hover:text-white bg-white/10 hover:bg-white/20 rounded-lg cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>تراجع</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveAllChanges}
                    disabled={savingAllChanges}
                    className="inline-flex items-center gap-1.5 px-5 py-2 text-xs sm:text-sm font-bold text-[#14213D] bg-[#A67C37] hover:bg-[#BC924B] disabled:opacity-50 rounded-lg cursor-pointer shadow-sm"
                  >
                    <Save className="w-4 h-4" aria-hidden="true" />
                    <span>
                      {savingAllChanges
                        ? 'جاري الحفظ...'
                        : `حفظ جميع التغييرات (${pendingChangesCount})`}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* TAB 4: PROMO CODES MANAGEMENT */}
        {activeTab === 'promo_codes' && (
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            <form
              onSubmit={handleAddPromoCode}
              className="lg:col-span-5 bg-white rounded-2xl border border-black/10 p-6 space-y-4"
            >
              <div className="flex items-center gap-2">
                <Tag className="w-5 h-5 text-[#6B1D2F]" aria-hidden="true" />
                <h2 className="font-display text-2xl font-bold text-[#14213D]">
                  إنشاء بروموكود خصم باسم أي شخص
                </h2>
              </div>
              <p className="text-xs text-[#5A5E6B] leading-relaxed">
                أضف كود خصم باسم زبون مميز، مؤثر، أو مندوب ليتسنى لمتابعيه
                استخدامه في سلة المشتريات وحساب عدد مرات الاستخدام تلقائياً.
              </p>

              <div>
                <label
                  htmlFor="promo-code-field"
                  className="block text-xs font-semibold text-[#14213D] mb-1"
                >
                  كود الخصم (أحرف أو أرقام)
                </label>
                <input
                  id="promo-code-field"
                  type="text"
                  required
                  dir="ltr"
                  value={promoCodeInput}
                  onChange={(e) =>
                    setPromoCodeInput(e.target.value.toUpperCase())
                  }
                  placeholder="OMAR15"
                  className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg text-center uppercase tracking-wider font-bold"
                />
              </div>

              <div>
                <label
                  htmlFor="promo-owner-field"
                  className="block text-xs font-semibold text-[#14213D] mb-1"
                >
                  اسم الشخص صاحب البروموكود
                </label>
                <input
                  id="promo-owner-field"
                  type="text"
                  required
                  value={promoOwnerInput}
                  onChange={(e) => setPromoOwnerInput(e.target.value)}
                  placeholder="مثال: عمر علي / الكابتن سيف"
                  className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="promo-type-field"
                    className="block text-xs font-semibold text-[#14213D] mb-1"
                  >
                    نوع الخصم
                  </label>
                  <select
                    id="promo-type-field"
                    value={promoDiscountType}
                    onChange={(e) =>
                      setPromoDiscountType(e.target.value as PromoDiscountType)
                    }
                    className="w-full ps-3 pe-8 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                  >
                    <option value="percent">نسبة مئوية (%)</option>
                    <option value="fixed">مبلغ ثابت (د.ع)</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="promo-value-field"
                    className="block text-xs font-semibold text-[#14213D] mb-1"
                  >
                    {promoDiscountType === 'percent'
                      ? 'نسبة الخصم (%)'
                      : 'مبلغ الخصم (د.ع)'}
                  </label>
                  <input
                    id="promo-value-field"
                    type="number"
                    required
                    min={promoDiscountType === 'percent' ? 1 : 500}
                    max={promoDiscountType === 'percent' ? 100 : undefined}
                    value={promoDiscountValue}
                    onChange={(e) => setPromoDiscountValue(e.target.value)}
                    placeholder={
                      promoDiscountType === 'percent' ? '15' : '5000'
                    }
                    className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg tabular-nums"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label
                    htmlFor="promo-duration-field"
                    className="block text-xs font-semibold text-[#14213D]"
                  >
                    مدة الصلاحية (بالأيام)
                  </label>
                  <span className="text-[11px] text-[#5A5E6B]">
                    0 = دائم بدون انتهاء
                  </span>
                </div>
                <input
                  id="promo-duration-field"
                  type="number"
                  min={0}
                  max={3650}
                  value={promoDurationDays}
                  onChange={(e) => setPromoDurationDays(e.target.value)}
                  placeholder="30"
                  className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg tabular-nums"
                />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {[
                    { days: '7', label: '7 أيام' },
                    { days: '14', label: '14 يوم' },
                    { days: '30', label: '30 يوم' },
                    { days: '90', label: '90 يوم' },
                    { days: '0', label: 'دائم (0)' },
                  ].map((preset) => (
                    <button
                      key={preset.days}
                      type="button"
                      onClick={() => setPromoDurationDays(preset.days)}
                      className={`px-2.5 py-1 text-[11px] font-semibold rounded-md cursor-pointer ${
                        promoDurationDays === preset.days
                          ? 'bg-[#14213D] text-white'
                          : 'bg-[#F2EFE9] text-[#3B3F4A] hover:bg-[#E5E0D5]'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={promoBusy}
                className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-5 text-sm font-semibold text-white bg-[#1E6B52] hover:bg-[#17523E] disabled:opacity-50 rounded-lg cursor-pointer"
              >
                <Save className="w-4 h-4" aria-hidden="true" />
                <span>
                  {promoBusy ? 'جاري الحفظ...' : 'حفظ وتفعيل كود الخصم'}
                </span>
              </button>
            </form>

            <div className="lg:col-span-7 bg-white rounded-2xl border border-black/10 divide-y divide-black/8">
              <div className="px-6 py-4">
                <h2 className="font-display text-xl font-bold text-[#14213D]">
                  أكواد الخصم المسجلة ({promoCodes.length})
                </h2>
              </div>

              {promoCodes.length === 0 ? (
                <div className="p-12 text-center text-sm text-[#5A5E6B]">
                  لا توجد أكواد خصم حالياً. أضف أول بروموكود باسم أي شخص من
                  النموذج الجانبي.
                </div>
              ) : (
                promoCodes.map((promo) => {
                  const validity = isPromoCodeValidNow(promo);
                  return (
                    <div
                      key={promo.id}
                      className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center flex-wrap gap-2">
                          <span
                            dir="ltr"
                            className="text-base font-bold text-[#14213D] tracking-wider tabular-nums"
                          >
                            {promo.code}
                          </span>
                          <span
                            className={`text-xs font-bold ${
                              validity.expired
                                ? 'text-[#9E1C28]'
                                : promo.active
                                  ? 'text-[#17523E]'
                                  : 'text-[#9E1C28]'
                            }`}
                          >
                            ·{' '}
                            {validity.expired
                              ? 'منتهي الصلاحية'
                              : promo.active
                                ? 'مفعّل'
                                : 'متوقف'}
                          </span>
                        </div>
                        <p className="text-sm font-semibold text-[#6B1D2F]">
                          صاحب الكود: {promo.ownerName}
                        </p>
                        <p className="text-xs text-[#5A5E6B] tabular-nums">
                          قيمة الخصم:{' '}
                          {promo.discountType === 'percent'
                            ? `${promo.discountValue}%`
                            : formatIQD(promo.discountValue)}{' '}
                          ·{' '}
                          {validity.remainingDays === null
                            ? 'دائم — بدون انتهاء'
                            : validity.expired
                              ? 'انتهت مدة الصلاحية'
                              : `صالح لمدة ${validity.remainingDays} يوم`}{' '}
                          · الاستخدام: {promo.timesUsed}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleTogglePromoCode(promo)}
                          className={`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${
                            promo.active
                              ? 'bg-[#F2EFE9] text-[#14213D] hover:bg-[#E5E0D5]'
                              : 'bg-[#F0F7F4] text-[#17523E] hover:bg-[#DCEFE7]'
                          }`}
                        >
                          {promo.active ? 'إيقاف مؤقت' : 'إعادة تفعيل'}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDeletePromoCode(promo)}
                          aria-label={`حذف بروموكود ${promo.code}`}
                          className="p-2 text-[#9E1C28] hover:bg-[#FDF2F2] rounded-lg cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}

        {/* TAB 4: SOCIAL LINKS MANAGEMENT */}
        {activeTab === 'social' && (
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            <form
              onSubmit={handleAddSocialLink}
              className="lg:col-span-5 bg-white rounded-2xl border border-black/10 p-6 space-y-4"
            >
              <h2 className="font-display text-2xl font-bold text-[#14213D]">
                إضافة موقع تواصل اجتماعي
              </h2>

              <div>
                <label
                  htmlFor="soc-platform"
                  className="block text-xs font-semibold text-[#14213D] mb-1"
                >
                  المنصة
                </label>
                <input
                  id="soc-platform"
                  type="text"
                  required
                  value={sPlatform}
                  onChange={(e) => setSPlatform(e.target.value)}
                  placeholder="مثال: فيسبوك، تيليغرام، سناب شات"
                  className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                />
              </div>

              <div>
                <label
                  htmlFor="soc-label"
                  className="block text-xs font-semibold text-[#14213D] mb-1"
                >
                  العنوان الظاهر في الموقع
                </label>
                <input
                  id="soc-label"
                  type="text"
                  value={sLabel}
                  onChange={(e) => setSLabel(e.target.value)}
                  placeholder="مثال: قناة بلوكرانا على تيليغرام"
                  className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg"
                />
              </div>

              <div>
                <label
                  htmlFor="soc-handle"
                  className="block text-xs font-semibold text-[#14213D] mb-1"
                >
                  اليوزر أو الرقم
                </label>
                <input
                  id="soc-handle"
                  type="text"
                  required
                  dir="ltr"
                  value={sHandle}
                  onChange={(e) => setSHandle(e.target.value)}
                  placeholder="@blaugrana.perfumes"
                  className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg text-right"
                />
              </div>

              <div>
                <label
                  htmlFor="soc-url"
                  className="block text-xs font-semibold text-[#14213D] mb-1"
                >
                  الرابط الكامل
                </label>
                <input
                  id="soc-url"
                  type="url"
                  required
                  dir="ltr"
                  value={sUrl}
                  onChange={(e) => setSUrl(e.target.value)}
                  placeholder="https://t.me/blaugrana_perfumes"
                  className="w-full px-3 py-2 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg text-right"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2.5 px-5 text-sm font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] rounded-lg cursor-pointer"
              >
                إضافة رابط التواصل
              </button>
            </form>

            <div className="lg:col-span-7 bg-white rounded-2xl border border-black/10 divide-y divide-black/8">
              <div className="px-6 py-4">
                <h2 className="font-display text-xl font-bold text-[#14213D]">
                  روابط التواصل النشطة ({socialLinks.length})
                </h2>
              </div>
              {socialLinks.map((link) => (
                <div
                  key={link.id}
                  className="p-4 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[#14213D]">
                      {link.label} ({link.platform})
                    </p>
                    <p className="text-xs text-[#5A5E6B] truncate" dir="ltr">
                      {link.handle} · {link.url}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteSocialLink(link.id)}
                    aria-label={`حذف ${link.label}`}
                    className="p-2 text-[#9E1C28] hover:bg-[#FDF2F2] rounded-lg cursor-pointer shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
