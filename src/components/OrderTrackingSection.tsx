import {
  CheckCircle2,
  Clock,
  MapPin,
  PackageCheck,
  RefreshCw,
  Search,
  ShieldCheck,
  Truck,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { apiUrl, isMaintenanceResponse, warmApiServer } from '../lib/apiClient';
import {
  ORDER_PROGRESS_STEPS,
  formatArabicDateTime,
  formatIQD,
  getOrderProgressStepIndex,
  type Order,
} from '../utils/commerce';

export interface TrackedOrderView {
  id: string;
  orderNumber: string;
  createdAt: string;
  deliveredAt?: string;
  fullName: string;
  exactLocation: string;
  phone: string;
  items: Order['items'];
  pricing: Order['pricing'];
  voucherCode: string;
  status: Order['status'];
  estimatedArrival: string;
  statusMessage: string;
  statusHistory: Order['statusHistory'];
}

interface OrderTrackingSectionProps {
  initialTrackedOrder: TrackedOrderView | null;
}

export function OrderTrackingSection({
  initialTrackedOrder,
}: OrderTrackingSectionProps) {
  const [orderNumber, setOrderNumber] = useState(
    initialTrackedOrder?.orderNumber ?? ''
  );
  const [phone, setPhone] = useState(initialTrackedOrder?.phone ?? '');
  const [trackedOrder, setTrackedOrder] = useState<TrackedOrderView | null>(
    initialTrackedOrder
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialTrackedOrder) {
      setOrderNumber(initialTrackedOrder.orderNumber);
      setPhone(initialTrackedOrder.phone);
      setTrackedOrder(initialTrackedOrder);
      setError('');
    }
  }, [initialTrackedOrder]);

  const fetchTrackedOrder = async (ordNum: string, tel: string) => {
    setError('');
    setLoading(true);
    try {
      const params = new URLSearchParams({
        orderNumber: ordNum.trim(),
        phone: tel.trim(),
      });
      const res = await fetch(apiUrl(`/api/orders/track?${params.toString()}`));
      const data = (await res.json()) as {
        order?: TrackedOrderView;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.order) {
        setError(
          isMaintenanceResponse(res.status, data)
            ? data.error ?? 'الخدمة في وضع الصيانة المؤقتة حالياً.'
            : data.error ?? 'تعذر العثور على الطلب.'
        );
        setTrackedOrder(null);
        return;
      }
      setTrackedOrder(data.order);
    } catch {
      setError('حدث خطأ في الاتصال بالخادم، يرجى المحاولة مجدداً.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await fetchTrackedOrder(orderNumber, phone);
  };

  const activeStepIdx = trackedOrder
    ? getOrderProgressStepIndex(trackedOrder.status)
    : -1;

  return (
    <section
      id="track-order"
      className="scroll-mt-20 py-14 bg-[#F2EFE9] border-t border-black/8"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Lookup Form */}
          <div className="lg:col-span-5 bg-white rounded-2xl border border-black/10 p-6 sm:p-8 space-y-5 shadow-sm">
            <div>
              <p className="text-xs font-semibold text-[#6B1D2F]">
                متابعة فورية لحالة الطلب والتوصيل
              </p>
              <h2 className="font-display text-3xl font-bold text-[#14213D] mt-1">
                تتبع طلبك ووقت الوصول
              </h2>
              <p className="text-sm text-[#5A5E6B] mt-2 leading-relaxed">
                أدخل رقم طلبك ورقم الهاتف لمعرفة حالة الطلب الحالية (تم
                الاستلام، تم التجهيز، قيد التوصيل، أو تم التسليم) مع وقت الوصول
                المتوقع وكامل التفاصيل.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="track-order-number"
                  className="block text-sm font-semibold text-[#14213D] mb-1.5"
                >
                  رقم الطلب
                </label>
                <input
                  id="track-order-number"
                  type="text"
                  dir="ltr"
                  value={orderNumber}
                  onFocus={() => void warmApiServer()}
                  onChange={(e) => setOrderNumber(e.target.value)}
                  placeholder="BG-1001"
                  className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg text-right tabular-nums focus:outline-2 focus:outline-[#6B1D2F]"
                />
              </div>

              <div>
                <label
                  htmlFor="track-order-phone"
                  className="block text-sm font-semibold text-[#14213D] mb-1.5"
                >
                  رقم الهاتف المستخدم في الطلب
                </label>
                <input
                  id="track-order-phone"
                  type="tel"
                  dir="ltr"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="077XXXXXXXX"
                  className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg text-right tabular-nums focus:outline-2 focus:outline-[#6B1D2F]"
                />
              </div>

              {error && (
                <p
                  role="alert"
                  className="text-xs text-[#9E1C28] bg-[#FDF2F2] border border-[#9E1C28]/20 p-3 rounded-lg"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 py-3 px-6 text-sm font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] disabled:opacity-50 rounded-lg transition-colors cursor-pointer min-h-[44px]"
              >
                <Search className="w-4 h-4" aria-hidden="true" />
                <span>{loading ? 'جاري البحث...' : 'عرض حالة الطلب'}</span>
              </button>
            </form>
          </div>

          {/* Live Order Status Card */}
          <div className="lg:col-span-7">
            {!trackedOrder ? (
              <div className="bg-white rounded-2xl border border-black/10 p-8 sm:p-10 text-center space-y-4">
                <div className="w-12 h-12 rounded-xl bg-[#FAF8F5] border border-black/10 text-[#6B1D2F] flex items-center justify-center mx-auto">
                  <Truck className="w-6 h-6" aria-hidden="true" />
                </div>
                <h3 className="font-display text-2xl font-bold text-[#14213D]">
                  كل تفاصيل طلبك في مكان واحد
                </h3>
                <p className="text-sm text-[#5A5E6B] max-w-md mx-auto leading-relaxed">
                  فور إتمام طلبك سيظهر هنا مباشرةً إشعار{' '}
                  <strong>تم الاستلام</strong> ثم{' '}
                  <strong>التجهيز والتوصيل والتسليم</strong> مع تحديثات وقت
                  الوصول من إدارة الوكالة.
                </p>
              </div>
            ) : (
              <article
                data-testid="tracked-order-card"
                className="bg-white rounded-2xl border border-black/10 p-6 sm:p-8 space-y-6 shadow-sm"
              >
                {/* Top Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-black/10">
                  <div>
                    <div className="flex items-center flex-wrap gap-2 text-xs text-[#5A5E6B] tabular-nums">
                      <span className="font-bold text-[#6B1D2F]">
                        طلب #{trackedOrder.orderNumber}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        تاريخ الطلب:{' '}
                        {formatArabicDateTime(trackedOrder.createdAt)}
                      </span>
                    </div>
                    <h3 className="font-display text-2xl font-bold text-[#14213D] mt-1">
                      الحالة الحالية: {trackedOrder.status}
                    </h3>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      fetchTrackedOrder(
                        trackedOrder.orderNumber,
                        trackedOrder.phone
                      )
                    }
                    disabled={loading}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#14213D] bg-[#FAF8F5] hover:bg-[#F2EFE9] border border-black/12 rounded-lg cursor-pointer self-start sm:self-auto"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
                      aria-hidden="true"
                    />
                    <span>تحديث الحالة</span>
                  </button>
                </div>

                {/* Estimated Arrival + Agency Status Note */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="p-4 rounded-xl bg-[#14213D] text-white space-y-1">
                    <p className="text-xs text-[#E8CFA0] inline-flex items-center gap-1.5 font-semibold">
                      <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>وقت الوصول المتوقع</span>
                    </p>
                    <p className="text-base font-bold">
                      {trackedOrder.estimatedArrival}
                    </p>
                    {trackedOrder.deliveredAt && (
                      <p className="text-xs text-[#E8CFA0] pt-1 tabular-nums">
                        تم التسليم في:{' '}
                        {formatArabicDateTime(trackedOrder.deliveredAt)}
                      </p>
                    )}
                  </div>

                  <div className="p-4 rounded-xl bg-[#FAF8F5] border border-black/10 space-y-1">
                    <p className="text-xs text-[#6B1D2F] inline-flex items-center gap-1.5 font-semibold">
                      <PackageCheck className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>رسالة المتابعة للزبون</span>
                    </p>
                    <p className="text-xs sm:text-sm text-[#14213D] leading-relaxed">
                      {trackedOrder.statusMessage}
                    </p>
                  </div>
                </div>

                {/* 4-Stage Visual Progress Stepper */}
                <div>
                  <p className="text-xs font-semibold text-[#5A5E6B] mb-3">
                    مراحل تنفيذ الطلب
                  </p>
                  <ol className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    {ORDER_PROGRESS_STEPS.map((stepLabel, idx) => {
                      const done = idx <= activeStepIdx;
                      const current = idx === activeStepIdx;
                      return (
                        <li
                          key={stepLabel}
                          className={`p-3 rounded-xl border text-center space-y-1 ${
                            current
                              ? 'bg-[#6B1D2F] text-white border-[#6B1D2F]'
                              : done
                                ? 'bg-[#F0F7F4] text-[#17523E] border-[#1E6B52]/25'
                                : 'bg-[#FAF8F5] text-[#7A7E8A] border-black/10'
                          }`}
                        >
                          <div className="flex items-center justify-center gap-1 text-xs font-bold">
                            {done && (
                              <CheckCircle2
                                className="w-3.5 h-3.5 shrink-0"
                                aria-hidden="true"
                              />
                            )}
                            <span>{stepLabel}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </div>

                {/* Chronological Status Log */}
                {trackedOrder.statusHistory.length > 0 && (
                  <div className="p-4 rounded-xl bg-[#FAF8F5] border border-black/8 space-y-2.5">
                    <p className="text-xs font-bold text-[#14213D]">
                      سجل حركة الطلب والتحديثات
                    </p>
                    <ul className="space-y-2 text-xs">
                      {[...trackedOrder.statusHistory]
                        .reverse()
                        .map((ev, idx) => (
                          <li
                            key={`${ev.status}-${ev.timestamp}-${idx}`}
                            className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 pb-2 last:pb-0 border-b last:border-b-0 border-black/8"
                          >
                            <div>
                              <span className="font-bold text-[#6B1D2F]">
                                {ev.status}
                              </span>
                              {ev.note && (
                                <span className="text-[#454954] mr-2">
                                  — {ev.note}
                                </span>
                              )}
                            </div>
                            <span className="text-[#5A5E6B] tabular-nums shrink-0">
                              {formatArabicDateTime(ev.timestamp)}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}

                {/* Customer + Items + Financial Summary */}
                <div className="pt-4 border-t border-black/10 space-y-3 text-xs sm:text-sm">
                  <div className="flex items-start gap-2 text-[#454954]">
                    <MapPin
                      className="w-4 h-4 text-[#6B1D2F] shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <span>
                      <strong>الزبون:</strong> {trackedOrder.fullName} ·{' '}
                      <strong>العنوان:</strong> {trackedOrder.exactLocation}
                    </span>
                  </div>

                  <ul className="space-y-1.5 bg-[#FAF8F5] p-3.5 rounded-xl border border-black/8">
                    {trackedOrder.items.map((item, idx) => (
                      <li
                        key={`${item.productId}-${idx}`}
                        className="flex justify-between gap-2 text-[#12141A] tabular-nums"
                      >
                        <span>
                          #{item.code} {item.name}
                          {item.size ? ` (${item.size})` : ''} × {item.quantity}
                          {item.includesFreeTester ? ' (+تيستر مجاني)' : ''}
                        </span>
                        <span className="font-semibold">
                          {formatIQD(item.priceIqd * item.quantity)}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {trackedOrder.pricing.promoDiscountIqd > 0 &&
                    trackedOrder.pricing.promoCode && (
                      <p className="text-xs font-semibold text-[#17523E] tabular-nums">
                        خصم بروموكود {trackedOrder.pricing.promoCode} (
                        {trackedOrder.pricing.promoOwnerName}): -{' '}
                        {formatIQD(trackedOrder.pricing.promoDiscountIqd)}
                      </p>
                    )}

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2 text-xs text-[#454954] tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      <ShieldCheck
                        className="w-4 h-4 text-[#A67C37]"
                        aria-hidden="true"
                      />
                      التيسترات المجانية: {trackedOrder.pricing.freeTestersCount}{' '}
                      · القسيمة: {trackedOrder.voucherCode} · التوصيل:{' '}
                      {trackedOrder.pricing.qualifiesForFreeDelivery
                        ? 'مجاني'
                        : formatIQD(trackedOrder.pricing.deliveryFeeIqd)}
                    </span>
                    <span className="text-base font-bold text-[#14213D]">
                      الإجمالي: {formatIQD(trackedOrder.pricing.totalIqd)}
                    </span>
                  </div>
                </div>
              </article>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
