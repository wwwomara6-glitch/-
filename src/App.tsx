/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminDashboard, type AdminAuthState } from './components/AdminDashboard';
import { CartCheckoutDrawer } from './components/CartCheckoutDrawer';
import { CatalogSection } from './components/CatalogSection';
import { CustomRequestSection } from './components/CustomRequestSection';
import { FooterSection } from './components/FooterSection';
import { HeroSection } from './components/HeroSection';
import { LoyaltySection } from './components/LoyaltySection';
import { Navbar } from './components/Navbar';
import {
  OrderTrackingSection,
  type TrackedOrderView,
} from './components/OrderTrackingSection';
import { ProductDetailModal } from './components/ProductDetailModal';
import { apiUrl, warmApiServer } from './lib/apiClient';
import { invalidateCatalogCache, loadFirestoreCatalog } from './lib/firebaseCatalog';
import {
  isQualifyingPerfumeCategory,
  resolveProductUnitPrice,
  type CartItemInput,
  type Order,
  type Product,
  type SocialLink,
  type StoreInfo,
} from './utils/commerce';

interface BootstrapPayload {
  storeInfo: StoreInfo;
  products: Product[];
  socialLinks: SocialLink[];
  adminAuthState: AdminAuthState;
}

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

export default function App() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [storeInfo, setStoreInfo] = useState<StoreInfo>(FALLBACK_STORE_INFO);
  const [products, setProducts] = useState<Product[]>([]);
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>([]);
  const [adminAuthState, setAdminAuthState] = useState<AdminAuthState>({
    configured: false,
    mode: 'unclaimed',
  });

  const [cart, setCart] = useState<CartItemInput[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [isAdminView, setIsAdminView] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('admin') === '1';
  });
  const [toastMsg, setToastMsg] = useState('');
  const [lastTrackedOrder, setLastTrackedOrder] =
    useState<TrackedOrderView | null>(null);

  const fetchBootstrap = useCallback(
    async (options?: { forceFirestoreRefresh?: boolean; forceApiBootstrap?: boolean }) => {
      try {
        setLoadError('');
        const forceRefresh = Boolean(options?.forceFirestoreRefresh);
        if (forceRefresh) {
          invalidateCatalogCache();
        }

        const firestoreSnapshot = await loadFirestoreCatalog({
          timeoutMs: 2500,
          forceRefresh,
          revalidateOnColdPageLoad: true,
        })
          .then((res) => (res.ok ? res.snapshot : null))
          .catch(() => null);

        if (firestoreSnapshot && firestoreSnapshot.products.length > 0) {
          setStoreInfo(firestoreSnapshot.storeInfo);
          setProducts(firestoreSnapshot.products);
          setSocialLinks(firestoreSnapshot.socialLinks);
          if (options?.forceApiBootstrap) {
            fetch(apiUrl('/api/bootstrap'))
              .then((res) => (res.ok ? (res.json() as Promise<BootstrapPayload>) : null))
              .then((data) => {
                if (data?.adminAuthState) setAdminAuthState(data.adminAuthState);
              })
              .catch(() => {});
          }
          return;
        }

        const res = await fetch(apiUrl('/api/bootstrap'));
        if (!res.ok) {
          throw new Error('Failed to load catalog');
        }
        const legacyData = (await res.json()) as BootstrapPayload;
        setStoreInfo(legacyData.storeInfo);
        setProducts(legacyData.products);
        setSocialLinks(legacyData.socialLinks);
        setAdminAuthState(legacyData.adminAuthState);
      } catch {
        setLoadError('تعذر تحميل بيانات المتجر، يرجى إعادة المحاولة.');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchBootstrap({ forceApiBootstrap: isAdminView });
  }, [fetchBootstrap, isAdminView]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('bg_last_order');
      if (!saved) return;
      const parsed = JSON.parse(saved) as {
        orderNumber?: string;
        phone?: string;
      };
      if (!parsed.orderNumber || !parsed.phone) return;
      const params = new URLSearchParams({
        orderNumber: parsed.orderNumber,
        phone: parsed.phone,
      });
      fetch(apiUrl(`/api/orders/track?${params.toString()}`))
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { order?: TrackedOrderView } | null) => {
          if (data?.order) setLastTrackedOrder(data.order);
        })
        .catch(() => {});
    } catch {
      // ignore invalid localStorage state
    }
  }, []);

  useEffect(() => {
    if (!toastMsg) return;
    const timer = setTimeout(() => setToastMsg(''), 3000);
    return () => clearTimeout(timer);
  }, [toastMsg]);

  const handleAddToCart = (product: Product, selectedSize?: string) => {
    const resolvedSize = resolveProductUnitPrice(product, selectedSize).size;
    setCart((prev) => {
      const existing = prev.find(
        (item) =>
          item.product.id === product.id &&
          (item.selectedSize ?? resolveProductUnitPrice(item.product).size) ===
            resolvedSize
      );
      if (existing) {
        return prev.map((item) =>
          item.product.id === product.id &&
          (item.selectedSize ?? resolveProductUnitPrice(item.product).size) ===
            resolvedSize
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }
      return [...prev, { product, selectedSize: resolvedSize, quantity: 1 }];
    });
    setToastMsg(`تمت إضافة «${product.name} (${resolvedSize})» إلى السلة`);
  };

  const handleUpdateQuantity = (
    productId: string,
    selectedSize: string,
    delta: number
  ) => {
    setCart((prev) =>
      prev
        .map((item) =>
          item.product.id === productId &&
          (item.selectedSize ?? resolveProductUnitPrice(item.product).size) ===
            selectedSize
            ? { ...item, quantity: item.quantity + delta }
            : item
        )
        .filter((item) => item.quantity > 0)
    );
  };

  const handleRemoveItem = (productId: string, selectedSize: string) => {
    setCart((prev) =>
      prev.filter(
        (item) =>
          !(
            item.product.id === productId &&
            (item.selectedSize ?? resolveProductUnitPrice(item.product).size) ===
              selectedSize
          )
      )
    );
  };

  const handleClearCart = () => {
    setCart([]);
  };

  const totalCartItems = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity, 0),
    [cart]
  );

  const currentCartPerfumeCount = useMemo(
    () =>
      cart.reduce(
        (sum, item) =>
          isQualifyingPerfumeCategory(item.product.category)
            ? sum + item.quantity
            : sum,
        0
      ),
    [cart]
  );

  const ownerWhatsappPhone = useMemo(() => {
    const wa = socialLinks.find(
      (s) => s.platform.includes('واتساب') || s.url.includes('wa.me')
    );
    return wa?.handle || '07745306712';
  }, [socialLinks]);

  const handleOrderCompleted = (order: Order) => {
    setLastTrackedOrder({
      id: order.id,
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      deliveredAt: order.deliveredAt,
      fullName: order.fullName,
      exactLocation: order.exactLocation,
      phone: order.phone,
      items: order.items,
      pricing: order.pricing,
      voucherCode: order.voucherCode,
      status: order.status,
      estimatedArrival: order.estimatedArrival,
      statusMessage: order.statusMessage,
      statusHistory: order.statusHistory,
    });
    try {
      window.localStorage.setItem(
        'bg_last_order',
        JSON.stringify({ orderNumber: order.orderNumber, phone: order.phone })
      );
    } catch {
      // ignore storage errors
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF8F5] text-[#12141A]">
      <Navbar
        cartCount={totalCartItems}
        onOpenCart={() => {
          void warmApiServer();
          setIsCartOpen(true);
        }}
        onOpenAdmin={() => {
          void warmApiServer();
          setIsAdminView(true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        isAdminView={isAdminView}
        onExitAdmin={() => setIsAdminView(false)}
      />

      {loading ? (
        <main className="flex-1 flex items-center justify-center py-24 px-4">
          <div className="text-center space-y-3">
            <p className="font-display text-2xl font-bold text-[#14213D]">
              جاري تجهيز وكالة بلوكرانا للعطور...
            </p>
            <p className="text-sm text-[#5A5E6B]">لحظات وتظهر المجموعة الكاملة</p>
          </div>
        </main>
      ) : loadError ? (
        <main className="flex-1 flex items-center justify-center py-24 px-4">
          <div className="text-center space-y-4 max-w-md bg-white p-8 rounded-2xl border border-black/10">
            <p className="font-display text-2xl font-bold text-[#9E1C28]">
              تعذر تحميل المتجر
            </p>
            <p className="text-sm text-[#5A5E6B]">{loadError}</p>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                fetchBootstrap();
              }}
              className="px-6 py-2.5 text-sm font-semibold text-white bg-[#14213D] rounded-lg hover:bg-[#6B1D2F] cursor-pointer"
            >
              إعادة المحاولة
            </button>
          </div>
        </main>
      ) : isAdminView ? (
        <AdminDashboard
          authState={adminAuthState}
          onAuthStateChange={setAdminAuthState}
          onExitAdmin={() => setIsAdminView(false)}
          onCatalogMutated={() => fetchBootstrap({ forceFirestoreRefresh: true })}
          storeInfo={storeInfo}
        />
      ) : (
        <main className="flex-1">
          <HeroSection
            storeInfo={storeInfo}
            onExploreCatalog={() =>
              document
                .getElementById('catalog')
                ?.scrollIntoView({ behavior: 'smooth' })
            }
            onOpenCustomRequest={() =>
              document
                .getElementById('custom-request')
                ?.scrollIntoView({ behavior: 'smooth' })
            }
          />

          <CatalogSection
            products={products}
            onAddToCart={handleAddToCart}
            onSelectProduct={setSelectedProduct}
          />

          <CustomRequestSection />

          <LoyaltySection currentCartPerfumeCount={currentCartPerfumeCount} />

          <OrderTrackingSection initialTrackedOrder={lastTrackedOrder} />
        </main>
      )}

      <FooterSection
        storeInfo={storeInfo}
        socialLinks={socialLinks}
        onOpenAdmin={() => {
          void warmApiServer();
          setIsAdminView(true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />

      <ProductDetailModal
        product={selectedProduct}
        onClose={() => setSelectedProduct(null)}
        onAddToCart={handleAddToCart}
      />

      <CartCheckoutDrawer
        isOpen={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        cart={cart}
        onUpdateQuantity={handleUpdateQuantity}
        onRemoveItem={handleRemoveItem}
        onClearCart={handleClearCart}
        ownerWhatsappPhone={ownerWhatsappPhone}
        onOrderCompleted={handleOrderCompleted}
      />

      {/* Non-blocking Add-to-Cart Toast */}
      {toastMsg && (
        <div
          role="status"
          className="fixed bottom-5 left-5 z-40 bg-[#14213D] text-white px-4 py-3 rounded-xl shadow-lg border border-white/15 flex items-center gap-3 text-xs sm:text-sm"
        >
          <span>{toastMsg}</span>
          <button
            type="button"
            onClick={() => {
              setToastMsg('');
              void warmApiServer();
              setIsCartOpen(true);
            }}
            className="text-[#E8CFA0] font-bold underline underline-offset-4 cursor-pointer whitespace-nowrap"
          >
            عرض السلة
          </button>
        </div>
      )}
    </div>
  );
}
