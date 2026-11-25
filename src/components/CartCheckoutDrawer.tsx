import {
  CheckCircle2,
  Clock,
  Gift,
  MessageCircle,
  Minus,
  Plus,
  ShieldCheck,
  Tag,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  FREE_DELIVERY_THRESHOLD_IQD,
  ORDER_PROGRESS_STEPS,
  buildOwnerOrderAlertMessage,
  buildWhatsAppUrl,
  calculateCartSummary,
  formatIQD,
  getOrderProgressStepIndex,
  normalizePhoneNumber,
  resolveProductUnitPrice,
  validateCheckoutInput,
  type AppliedPromoPreview,
  type CartItemInput,
  type LoyaltyProfile,
  type Order,
} from '../utils/commerce';
import { apiUrl, isMaintenanceResponse, warmApiServer } from '../lib/apiClient';
import { SafeImage } from './SafeImage';

interface CartCheckoutDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  cart: CartItemInput[];
  onUpdateQuantity: (
    productId: string,
    selectedSize: string,
    delta: number
  ) => void;
  onRemoveItem: (productId: string, selectedSize: string) => void;
  onClearCart: () => void;
  ownerWhatsappPhone?: string;
  onOrderCompleted?: (order: Order) => void;
}

type DrawerStep = 'cart' | 'checkout' | 'receipt';

export function CartCheckoutDrawer({
  isOpen,
  onClose,
  cart,
  onUpdateQuantity,
  onRemoveItem,
  onClearCart,
  ownerWhatsappPhone = '07745306712',
  onOrderCompleted,
}: CartCheckoutDrawerProps) {
  const [step, setStep] = useState<DrawerStep>('cart');

  const [fullName, setFullName] = useState('');
  const [exactLocation, setExactLocation] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [phone, setPhone] = useState('');

  const [priorPerfumes, setPriorPerfumes] = useState(0);
  const [promoInput, setPromoInput] = useState('');
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromoPreview | null>(
    null
  );
  const [promoError, setPromoError] = useState('');
  const [promoLoading, setPromoLoading] = useState(false);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [completedOrder, setCompletedOrder] = useState<{
    order: Order;
    loyalty: LoyaltyProfile;
    thankYouMessage: string;
  } | null>(null);

  useEffect(() => {
    if (isOpen) {
      void warmApiServer();
    }
  }, [isOpen]);

  useEffect(() => {
    const normalized = normalizePhoneNumber(phone);
    if (normalized.length < 10) {
      setPriorPerfumes(0);
      return;
    }
    let active = true;
    fetch(apiUrl(`/api/loyalty/${encodeURIComponent(normalized)}`))
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { loyalty?: LoyaltyProfile } | null) => {
        if (active && data?.loyalty) {
          setPriorPerfumes(data.loyalty.totalQualifyingPerfumes);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [phone]);

  if (!isOpen) return null;

  const summary = calculateCartSummary(cart, priorPerfumes, appliedPromo);
  const deliveryProgressPct = Math.min(
    100,
    Math.round(
      (summary.subtotalAfterDiscountIqd / FREE_DELIVERY_THRESHOLD_IQD) * 100
    )
  );

  const handleApplyPromo = async () => {
    const trimmed = promoInput.trim();
    if (!trimmed) {
      setPromoError('يرجى إدخال كود الخصم أولاً.');
      return;
    }
    setPromoError('');
    setPromoLoading(true);
    try {
      const res = await fetch(apiUrl('/api/promo-codes/validate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });
      const data = (await res.json()) as {
        promo?: AppliedPromoPreview;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.promo) {
        setAppliedPromo(null);
        setPromoError(
          isMaintenanceResponse(res.status, data)
            ? data.error ?? 'الخدمة في وضع الصيانة المؤقتة حالياً، يرجى المحاولة بعد قليل.'
            : data.error ?? 'كود الخصم غير صحيح أو غير مفعّل.'
        );
        return;
      }
      setAppliedPromo(data.promo);
      setPromoInput(data.promo.code);
      setPromoError('');
    } catch {
      setPromoError('تعذر التحقق من كود الخصم، حاول مجدداً.');
    } finally {
      setPromoLoading(false);
    }
  };

  const handleRemovePromo = () => {
    setAppliedPromo(null);
    setPromoInput('');
    setPromoError('');
  };

  const handleCheckoutSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError('');

    const validation = validateCheckoutInput({
      fullName,
      exactLocation,
      birthDate,
      phone,
      itemsCount: cart.length,
    });

    if (!validation.valid) {
      setErrors(validation.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl('/api/orders'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName,
          exactLocation,
          birthDate,
          phone,
          promoCode: appliedPromo?.code,
          items: cart.map((c) => ({
            productId: c.product.id,
            selectedSize: resolveProductUnitPrice(c.product, c.selectedSize).size,
            quantity: c.quantity,
          })),
        }),
      });
      const data = (await res.json()) as {
        order?: Order;
        loyalty?: LoyaltyProfile;
        thankYouMessage?: string;
        error?: string;
        code?: string;
        errors?: Record<string, string>;
      };

      if (!res.ok || !data.order || !data.loyalty) {
        if (data.errors) setErrors(data.errors);
        setServerError(
          isMaintenanceResponse(res.status, data)
            ? data.error ?? 'المتجر في وضع الصيانة المؤقتة حالياً لتحديث البيانات، يرجى المحاولة بعد قليل.'
            : data.error ?? 'تعذر إتمام الطلب، يرجى التحقق من البيانات.'
        );
        return;
      }

      setCompletedOrder({
        order: data.order,
        loyalty: data.loyalty,
        thankYouMessage:
          data.thankYouMessage ??
          'شكراً لك على طلبك من وكالة بلوكرانا للعطور!',
      });
      onOrderCompleted?.(data.order);
      onClearCart();
      setStep('receipt');
    } catch {
      setServerError('حدث خطأ في الاتصال، يرجى المحاولة مجدداً.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCloseDrawer = () => {
    if (step === 'receipt') {
      setStep('cart');
      setCompletedOrder(null);
      setFullName('');
      setExactLocation('');
      setBirthDate('');
      setPhone('');
      setAppliedPromo(null);
      setPromoInput('');
      setPromoError('');
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="سلة المشتريات وإتمام الطلب"
      onClick={handleCloseDrawer}
    >
      <div
        className="w-full max-w-lg bg-[#FAF8F5] h-full flex flex-col border-r border-black/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div className="px-6 py-4 bg-white border-b border-black/10 flex items-center justify-between">
          <div>
            <h2 className="font-display text-2xl font-bold text-[#14213D]">
              {step === 'cart' && 'سلة المشتريات'}
              {step === 'checkout' && 'معلومات الزبون وإتمام الطلب'}
              {step === 'receipt' && 'رسالة شكر وتقدير'}
            </h2>
            {step === 'cart' && (
              <p className="text-xs text-[#5A5E6B] tabular-nums">
                {summary.totalItemsCount} منتج في السلة
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleCloseDrawer}
            aria-label="إغلاق السلة"
            className="w-10 h-10 rounded-lg hover:bg-black/5 flex items-center justify-center text-[#3B3F4A] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {step === 'cart' && (
            <>
              {/* Free Delivery Meter */}
              <div className="p-4 rounded-xl bg-white border border-black/10 space-y-2.5">
                <div className="flex items-center justify-between text-xs sm:text-sm font-semibold text-[#14213D]">
                  <span className="inline-flex items-center gap-1.5">
                    <Truck className="w-4 h-4 text-[#6B1D2F]" aria-hidden="true" />
                    {summary.qualifiesForFreeDelivery
                      ? 'مبارك! حصلت على توصيل مجاني'
                      : `أضف ${formatIQD(summary.amountToFreeDeliveryIqd)} للتوصيل المجاني`}
                  </span>
                  <span className="tabular-nums text-xs text-[#5A5E6B]">
                    الحد: 20,000 د.ع
                  </span>
                </div>
                <div className="h-2 rounded-full bg-[#F2EFE9] overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      summary.qualifiesForFreeDelivery
                        ? 'bg-[#1E6B52]'
                        : 'bg-[#6B1D2F]'
                    }`}
                    style={{ width: `${deliveryProgressPct}%` }}
                  />
                </div>
              </div>

              {cart.length === 0 ? (
                <div className="py-16 text-center space-y-3">
                  <p className="font-display text-2xl font-bold text-[#14213D]">
                    سلتك فارغة حالياً
                  </p>
                  <p className="text-sm text-[#5A5E6B]">
                    أضف عطورك المفضلة واستمتع بتيستر مجاني مع كل عطر وخصم 4+1
                    مجاني.
                  </p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {cart.map(({ product, selectedSize, quantity }) => {
                    const resolved = resolveProductUnitPrice(
                      product,
                      selectedSize
                    );
                    return (
                      <li
                        key={`${product.id}-${resolved.size}`}
                        className="p-3.5 bg-white rounded-xl border border-black/10 flex gap-3.5 items-center"
                      >
                        <div className="w-16 h-16 rounded-lg overflow-hidden bg-[#F2EFE9] shrink-0">
                          <SafeImage
                            src={product.imageUrl}
                            alt={product.name}
                            className="w-full h-full object-cover"
                            fallbackLabel={product.code}
                          />
                        </div>

                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-[#6B1D2F] font-semibold tabular-nums">
                            رقم #{product.code} · {product.brand} ·{' '}
                            {resolved.size}
                          </p>
                          <h3 className="text-sm font-bold text-[#12141A] truncate">
                            {product.name}
                          </h3>
                          <p className="text-xs text-[#5A5E6B] tabular-nums mt-0.5">
                            {formatIQD(resolved.priceIqd)} × {quantity}
                          </p>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateQuantity(product.id, resolved.size, -1)
                            }
                            aria-label={`إنقاص كمية ${product.name} ${resolved.size}`}
                            className="w-8 h-8 rounded-lg bg-[#F2EFE9] hover:bg-[#E5E0D5] flex items-center justify-center text-[#12141A] cursor-pointer"
                          >
                            <Minus className="w-3.5 h-3.5" />
                          </button>
                          <span className="w-6 text-center text-sm font-bold tabular-nums">
                            {quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateQuantity(product.id, resolved.size, 1)
                            }
                            aria-label={`زيادة كمية ${product.name} ${resolved.size}`}
                            className="w-8 h-8 rounded-lg bg-[#F2EFE9] hover:bg-[#E5E0D5] flex items-center justify-center text-[#12141A] cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onRemoveItem(product.id, resolved.size)
                            }
                            aria-label={`حذف ${product.name} ${resolved.size}`}
                            className="w-8 h-8 rounded-lg hover:bg-[#FDF2F2] text-[#9E1C28] flex items-center justify-center cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Automatic Perks Summary */}
              {cart.length > 0 && (
                <div className="space-y-2.5 text-xs">
                  {summary.freeTestersCount > 0 && (
                    <div className="p-3 rounded-lg bg-[#F2EFE9] border border-black/8 flex items-center gap-2 text-[#14213D]">
                      <ShieldCheck
                        className="w-4 h-4 text-[#A67C37] shrink-0"
                        aria-hidden="true"
                      />
                      <span>
                        يشمل طلبك{' '}
                        <strong className="tabular-nums">
                          {summary.freeTestersCount} تيستر مجاني
                        </strong>{' '}
                        للتجربة مع ضمان الثبات والفوحان.
                      </span>
                    </div>
                  )}

                  {summary.freePerfumeUnitsEarned > 0 ? (
                    <div
                      data-testid="loyalty-discount-banner"
                      className="p-3 rounded-lg bg-[#F0F7F4] border border-[#1E6B52]/25 flex items-center gap-2 text-[#17523E]"
                    >
                      <Gift className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>
                        تم تفعيل قسيمة 4 + 1 مجاني! حصلت على{' '}
                        <strong className="tabular-nums">
                          {summary.freePerfumeUnitsEarned}
                        </strong>{' '}
                        عطر مجاني بقيمة خصم{' '}
                        <strong className="tabular-nums">
                          {formatIQD(summary.loyaltyDiscountIqd)}
                        </strong>
                        .
                      </span>
                    </div>
                  ) : (
                    summary.qualifyingPerfumeUnits > 0 && (
                      <div className="p-3 rounded-lg bg-[#F2EFE9] border border-black/8 text-[#454954]">
                        لديك{' '}
                        <strong className="tabular-nums">
                          {summary.qualifyingPerfumeUnits}
                        </strong>{' '}
                        عطر في السلة. عند إتمام 4 عطور، يصبح العطر الخامس مجانياً!
                      </div>
                    )
                  )}

                  {/* Promo Code Box inside Cart */}
                  <div className="p-3.5 rounded-xl bg-white border border-black/10 space-y-2.5">
                    <label
                      htmlFor="cart-promo-input"
                      className="flex items-center gap-1.5 text-xs font-bold text-[#14213D]"
                    >
                      <Tag className="w-3.5 h-3.5 text-[#6B1D2F]" aria-hidden="true" />
                      <span>هل لديك كود خصم (بروموكود)؟</span>
                    </label>

                    {appliedPromo ? (
                      <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-[#F0F7F4] border border-[#1E6B52]/25 text-[#17523E]">
                        <div className="text-xs">
                          <span className="font-bold tabular-nums">
                            {appliedPromo.code}
                          </span>{' '}
                          <span>
                            (باسم {appliedPromo.ownerName}) — خصم{' '}
                            {appliedPromo.discountType === 'percent'
                              ? `${appliedPromo.discountValue}%`
                              : formatIQD(appliedPromo.discountValue)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={handleRemovePromo}
                          className="text-xs font-bold text-[#9E1C28] hover:underline cursor-pointer shrink-0"
                        >
                          إزالة
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          id="cart-promo-input"
                          type="text"
                          dir="ltr"
                          value={promoInput}
                          onChange={(e) => setPromoInput(e.target.value)}
                          placeholder="أدخل البروموكود هنا..."
                          className="flex-1 px-3 py-2 text-xs bg-[#FAF8F5] border border-black/15 rounded-lg text-center uppercase tracking-wider focus:outline-2 focus:outline-[#6B1D2F]"
                        />
                        <button
                          type="button"
                          disabled={promoLoading}
                          onClick={handleApplyPromo}
                          className="px-4 py-2 text-xs font-bold text-white bg-[#14213D] hover:bg-[#6B1D2F] disabled:opacity-50 rounded-lg cursor-pointer shrink-0"
                        >
                          {promoLoading ? 'تحقق...' : 'تطبيق'}
                        </button>
                      </div>
                    )}
                    {promoError && (
                      <p role="alert" className="text-xs text-[#9E1C28]">
                        {promoError}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {step === 'checkout' && (
            <form
              id="checkout-form"
              onSubmit={handleCheckoutSubmit}
              noValidate
              className="space-y-4"
            >
              <div>
                <label
                  htmlFor="co-fullname"
                  className="block text-sm font-semibold text-[#14213D] mb-1.5"
                >
                  الاسم الكامل
                </label>
                <input
                  id="co-fullname"
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="الاسم الثلاثي"
                  className="w-full px-3.5 py-2.5 text-sm bg-white border border-black/15 rounded-lg focus:outline-2 focus:outline-[#6B1D2F]"
                />
                {errors.fullName && (
                  <p className="text-xs text-[#9E1C28] mt-1">{errors.fullName}</p>
                )}
              </div>

              <div>
                <label
                  htmlFor="co-location"
                  className="block text-sm font-semibold text-[#14213D] mb-1.5"
                >
                  الموقع بالتحديد
                </label>
                <input
                  id="co-location"
                  type="text"
                  value={exactLocation}
                  onChange={(e) => setExactLocation(e.target.value)}
                  placeholder="المحافظة · القضاء · الحي · أقرب نقطة دالة"
                  className="w-full px-3.5 py-2.5 text-sm bg-white border border-black/15 rounded-lg focus:outline-2 focus:outline-[#6B1D2F]"
                />
                {errors.exactLocation && (
                  <p className="text-xs text-[#9E1C28] mt-1">
                    {errors.exactLocation}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="co-birthdate"
                  className="block text-sm font-semibold text-[#14213D] mb-1.5"
                >
                  تاريخ الميلاد
                </label>
                <input
                  id="co-birthdate"
                  type="date"
                  value={birthDate}
                  onChange={(e) => setBirthDate(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-white border border-black/15 rounded-lg tabular-nums focus:outline-2 focus:outline-[#6B1D2F]"
                />
                {errors.birthDate && (
                  <p className="text-xs text-[#9E1C28] mt-1">
                    {errors.birthDate}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="co-phone"
                  className="block text-sm font-semibold text-[#14213D] mb-1.5"
                >
                  رقم الهاتف (يربط بقسيمة الولاء 4+1)
                </label>
                <input
                  id="co-phone"
                  type="tel"
                  dir="ltr"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="077XXXXXXXX"
                  className="w-full px-3.5 py-2.5 text-sm bg-white border border-black/15 rounded-lg text-right tabular-nums focus:outline-2 focus:outline-[#6B1D2F]"
                />
                {errors.phone && (
                  <p className="text-xs text-[#9E1C28] mt-1">{errors.phone}</p>
                )}
                {priorPerfumes > 0 && (
                  <p className="text-xs text-[#1E6B52] mt-1">
                    رصيدك السابق في القسيمة: {priorPerfumes} عطر.
                  </p>
                )}
              </div>

              {serverError && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-[#FDF2F2] border border-[#9E1C28]/25 text-xs text-[#9E1C28]"
                >
                  {serverError}
                </div>
              )}

              <div className="p-4 rounded-xl bg-[#F2EFE9] border border-black/10 text-xs text-[#454954] space-y-1">
                <p className="font-bold text-[#14213D]">طريقة الدفع: الدفع عند الاستلام</p>
                <p>
                  يتم فحص التيستر المجاني عند الاستلام مع ضمان الثبات والفوحان من
                  وكالة بلوكرانا للعطور.
                </p>
              </div>
            </form>
          )}

          {step === 'receipt' && completedOrder && (
            <div
              data-testid="order-thank-you-receipt"
              className="space-y-5 py-2"
            >
              <div className="p-6 rounded-2xl bg-[#14213D] text-white space-y-3">
                <div className="inline-flex items-center gap-2 text-[#E8CFA0] text-xs font-semibold">
                  <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
                  <span>حالة الطلب: {completedOrder.order.status}</span>
                </div>
                <h3 className="font-display text-2xl font-bold leading-snug">
                  شكراً لك يا {completedOrder.order.fullName}
                </h3>
                <p className="text-sm text-white/85 leading-relaxed">
                  {completedOrder.thankYouMessage}
                </p>
                <div className="pt-2 border-t border-white/15 space-y-1 text-xs text-[#E8CFA0] tabular-nums">
                  <p>
                    رقم الطلب: {completedOrder.order.orderNumber} · رقم القسيمة
                    الخاصة: {completedOrder.loyalty.voucherCode}
                  </p>
                  <p className="inline-flex items-center gap-1.5 text-white font-semibold">
                    <Clock className="w-3.5 h-3.5 text-[#E8CFA0]" aria-hidden="true" />
                    <span>
                      وقت الوصول المتوقع:{' '}
                      {completedOrder.order.estimatedArrival}
                    </span>
                  </p>
                </div>
              </div>

              {/* 4-Stage Status Bar */}
              <div className="p-4 rounded-xl bg-white border border-black/10 space-y-2.5">
                <p className="text-xs font-bold text-[#14213D]">
                  مراحل تنفيذ طلبك
                </p>
                <div className="grid grid-cols-4 gap-1.5 text-[11px] font-semibold text-center">
                  {ORDER_PROGRESS_STEPS.map((st, idx) => {
                    const active =
                      idx <=
                      getOrderProgressStepIndex(completedOrder.order.status);
                    return (
                      <div
                        key={st}
                        className={`py-2 px-1 rounded-lg border ${
                          active
                            ? 'bg-[#6B1D2F] text-white border-[#6B1D2F]'
                            : 'bg-[#FAF8F5] text-[#7A7E8A] border-black/10'
                        }`}
                      >
                        {st}
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-[#454954] leading-relaxed">
                  {completedOrder.order.statusMessage}
                </p>
              </div>

              {/* Notify Agency Directly on WhatsApp */}
              <div className="p-4 rounded-xl bg-[#F0F7F4] border border-[#1E6B52]/25 space-y-2.5">
                <p className="text-xs font-bold text-[#17523E]">
                  إرسال إشعار فوري للوكالة عبر واتساب لتسريع التجهيز
                </p>
                <a
                  href={buildWhatsAppUrl(
                    ownerWhatsappPhone,
                    buildOwnerOrderAlertMessage(completedOrder.order)
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-xs sm:text-sm font-semibold text-white bg-[#1E6B52] hover:bg-[#17523E] rounded-lg transition-colors"
                >
                  <MessageCircle className="w-4 h-4" aria-hidden="true" />
                  <span>إرسال تفاصيل الطلب إلى واتساب الوكالة</span>
                </a>
              </div>

              {/* Customer Voucher + Order Totals */}
              <div className="p-5 rounded-xl bg-white border border-black/10 space-y-3">
                <h4 className="font-bold text-sm text-[#14213D]">
                  ملخص الطلب وقسيمة الولاء (4 + 1 مجاني)
                </h4>
                <p className="text-xs text-[#5A5E6B]">
                  رصيدك المحدّث: {completedOrder.loyalty.stamps} من أصل 5 أختام ·
                  {completedOrder.loyalty.stampsRemainingForFree === 5
                    ? ' بدأت دورة جديدة (5 عطور قادمة للهدية)'
                    : ` متبقي ${completedOrder.loyalty.stampsRemainingForFree} للوصول للعطر المجاني`}
                </p>
                <p className="text-xs text-[#454954]">
                  التوصيل:{' '}
                  {completedOrder.order.pricing.qualifiesForFreeDelivery
                    ? 'مجاني'
                    : formatIQD(completedOrder.order.pricing.deliveryFeeIqd)}{' '}
                  · التيسترات المجانية:{' '}
                  {completedOrder.order.pricing.freeTestersCount}
                </p>
                {completedOrder.order.pricing.promoDiscountIqd > 0 &&
                  completedOrder.order.pricing.promoCode && (
                    <p className="text-xs font-semibold text-[#17523E] tabular-nums">
                      خصم بروموكود {completedOrder.order.pricing.promoCode} (
                      {completedOrder.order.pricing.promoOwnerName}): -{' '}
                      {formatIQD(completedOrder.order.pricing.promoDiscountIqd)}
                    </p>
                  )}
                <div className="flex justify-between text-sm pt-2 border-t border-black/10 tabular-nums">
                  <span className="text-[#5A5E6B]">المبلغ الإجمالي</span>
                  <span className="font-bold text-[#6B1D2F]">
                    {formatIQD(completedOrder.order.pricing.totalIqd)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Drawer Footer */}
        <div className="p-6 bg-white border-t border-black/10 space-y-4">
          {step !== 'receipt' && cart.length > 0 && (
            <div className="space-y-1.5 text-sm tabular-nums">
              <div className="flex justify-between text-[#5A5E6B]">
                <span>المجموع الفرعي</span>
                <span>{formatIQD(summary.rawSubtotalIqd)}</span>
              </div>
              {summary.loyaltyDiscountIqd > 0 && (
                <div className="flex justify-between text-[#1E6B52] font-semibold">
                  <span>خصم قسيمة 4 + 1 مجاني</span>
                  <span>- {formatIQD(summary.loyaltyDiscountIqd)}</span>
                </div>
              )}
              {summary.promoDiscountIqd > 0 && summary.promoCode && (
                <div
                  data-testid="cart-promo-discount-row"
                  className="flex justify-between text-[#1E6B52] font-semibold"
                >
                  <span>
                    خصم بروموكود {summary.promoCode} ({summary.promoOwnerName})
                  </span>
                  <span>- {formatIQD(summary.promoDiscountIqd)}</span>
                </div>
              )}
              <div className="flex justify-between text-[#5A5E6B]">
                <span>رسوم التوصيل</span>
                <span>
                  {summary.qualifiesForFreeDelivery
                    ? 'مجاني'
                    : formatIQD(summary.deliveryFeeIqd)}
                </span>
              </div>
              <div className="flex justify-between text-base font-bold text-[#14213D] pt-2 border-t border-black/10">
                <span>الإجمالي النهائي</span>
                <span>{formatIQD(summary.totalIqd)}</span>
              </div>
            </div>
          )}

          {step === 'cart' && cart.length > 0 && (
            <button
              type="button"
              onClick={() => setStep('checkout')}
              className="w-full py-3 px-6 text-sm font-semibold text-white bg-[#6B1D2F] hover:bg-[#531523] rounded-lg transition-colors cursor-pointer min-h-[44px]"
            >
              متابعة لإدخال معلومات التوصيل
            </button>
          )}

          {step === 'checkout' && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep('cart')}
                className="px-4 py-3 text-sm font-semibold text-[#14213D] bg-[#F2EFE9] hover:bg-[#E5E0D5] rounded-lg transition-colors cursor-pointer min-h-[44px]"
              >
                رجوع
              </button>
              <button
                type="submit"
                form="checkout-form"
                disabled={submitting}
                className="flex-1 py-3 px-6 text-sm font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] disabled:opacity-50 rounded-lg transition-colors cursor-pointer min-h-[44px]"
              >
                {submitting ? 'جاري تثبيت الطلب...' : 'تأكيد وإتمام الطلب'}
              </button>
            </div>
          )}

          {step === 'receipt' && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  handleCloseDrawer();
                  setTimeout(() => {
                    document
                      .getElementById('track-order')
                      ?.scrollIntoView({ behavior: 'smooth' });
                  }, 80);
                }}
                className="flex-1 py-3 px-4 text-sm font-semibold text-white bg-[#6B1D2F] hover:bg-[#531523] rounded-lg transition-colors cursor-pointer min-h-[44px]"
              >
                متابعة حالة الطلب الآن
              </button>
              <button
                type="button"
                onClick={handleCloseDrawer}
                className="px-4 py-3 text-sm font-semibold text-[#14213D] bg-[#F2EFE9] hover:bg-[#E5E0D5] rounded-lg transition-colors cursor-pointer min-h-[44px]"
              >
                إغلاق
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
