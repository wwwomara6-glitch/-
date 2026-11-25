import { CheckCircle2, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { apiUrl, isMaintenanceResponse, warmApiServer } from '../lib/apiClient';
import {
  formatIQD,
  validateCustomRequestInput,
} from '../utils/commerce';

interface CustomRequestSectionProps {
  onSubmitted?: () => void;
}

export function CustomRequestSection({
  onSubmitted,
}: CustomRequestSectionProps) {
  const [perfumeName, setPerfumeName] = useState('');
  const [expectedPrice, setExpectedPrice] = useState('');
  const [size, setSize] = useState('100 مل');
  const [desiredDate, setDesiredDate] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [notes, setNotes] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError('');
    setSuccessMsg('');

    const numericPrice = Number(expectedPrice);
    const check = validateCustomRequestInput({
      perfumeName,
      expectedPriceIqd: numericPrice,
      size,
      desiredDate,
      customerName,
      customerPhone,
    });

    if (!check.valid) {
      setErrors(check.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl('/api/custom-requests'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          perfumeName,
          expectedPriceIqd: numericPrice,
          size,
          desiredDate,
          customerName,
          customerPhone,
          notes,
        }),
      });
      const data = (await res.json()) as {
        message?: string;
        error?: string;
        code?: string;
        errors?: Record<string, string>;
      };

      if (!res.ok) {
        if (data.errors) setErrors(data.errors);
        setServerError(
          isMaintenanceResponse(res.status, data)
            ? data.error ?? 'المتجر في وضع الصيانة المؤقتة حالياً لتحديث البيانات، يرجى المحاولة بعد قليل.'
            : data.error ?? 'تعذر إرسال الطلب، يرجى المحاولة مجدداً.'
        );
        return;
      }

      setSuccessMsg(
        data.message ??
          `تم استلام طلب "وفرلي عطري" لعطر ${perfumeName} بسعر ${formatIQD(numericPrice)}.`
      );
      setPerfumeName('');
      setExpectedPrice('');
      setSize('100 مل');
      setDesiredDate('');
      setCustomerName('');
      setCustomerPhone('');
      setNotes('');
      onSubmitted?.();
    } catch {
      setServerError('حدث خطأ في الاتصال بالخادم، يرجى المحاولة لاحقاً.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      id="custom-request"
      className="scroll-mt-20 py-16 bg-[#F2EFE9] border-y border-black/10"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-8 grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        {/* Editorial Explanation */}
        <div className="lg:col-span-5 space-y-5">
          <p className="text-xs font-semibold text-[#6B1D2F]">
            خدمة خاصة من وكالة بلوكرانا
          </p>
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-[#14213D] text-balance">
            ميزة «وفرلي عطري»
          </h2>
          <p className="text-sm sm:text-base text-[#454954] leading-relaxed">
            هل تبحث عن عطر معين من شركة عالمية أو إصدار نادر غير معروض في
            القائمة؟ اكتب لنا اسم العطر، السعر المناسب لك، الحجم المطلوب،
            والتاريخ الذي ترغب بوصوله فيه، وسيتكفل فريق الوكالة بتوفيره لك
            بأعلى ثبات وفوحان.
          </p>

          <dl className="pt-4 border-t border-black/10 space-y-3 text-sm">
            <div>
              <dt className="font-bold text-[#14213D]">تجهيز حسب الطلب</dt>
              <dd className="text-[#5A5E6B]">
                نوفر العطور العالمية والعربية الأصلية والتركيبات الخاصة بدقة.
              </dd>
            </div>
            <div>
              <dt className="font-bold text-[#14213D]">الالتزام بالموعد</dt>
              <dd className="text-[#5A5E6B]">
                نرتب التوصيل وفق التاريخ الذي تحدده، مثالي للهدايا والمناسبات.
              </dd>
            </div>
          </dl>
        </div>

        {/* Form Card */}
        <div className="lg:col-span-7 bg-white rounded-2xl border border-black/10 p-6 sm:p-8">
          <form
            onSubmit={handleSubmit}
            noValidate
            className="grid grid-cols-1 sm:grid-cols-2 gap-5"
          >
            <div className="sm:col-span-2">
              <label
                htmlFor="req-perfume-name"
                className="block text-sm font-semibold text-[#14213D] mb-1.5"
              >
                اسم العطر المطلوب
              </label>
              <input
                id="req-perfume-name"
                type="text"
                value={perfumeName}
                onFocus={() => void warmApiServer()}
                onChange={(e) => setPerfumeName(e.target.value)}
                placeholder="مثال: بلو دي شانيل أو باكارا روج 540"
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg focus:outline-2 focus:outline-[#6B1D2F]"
              />
              {errors.perfumeName && (
                <p className="text-xs text-[#9E1C28] mt-1">{errors.perfumeName}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="req-expected-price"
                className="block text-sm font-semibold text-[#14213D] mb-1.5"
              >
                السعر المتوقع (دينار عراقي)
              </label>
              <input
                id="req-expected-price"
                type="number"
                min="1000"
                step="500"
                value={expectedPrice}
                onChange={(e) => setExpectedPrice(e.target.value)}
                placeholder="مثال: 35000"
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg tabular-nums focus:outline-2 focus:outline-[#6B1D2F]"
              />
              {errors.expectedPriceIqd && (
                <p className="text-xs text-[#9E1C28] mt-1">
                  {errors.expectedPriceIqd}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="req-size"
                className="block text-sm font-semibold text-[#14213D] mb-1.5"
              >
                الحجم المطلوب
              </label>
              <input
                id="req-size"
                type="text"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                placeholder="مثال: 100 مل"
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg focus:outline-2 focus:outline-[#6B1D2F]"
              />
              {errors.size && (
                <p className="text-xs text-[#9E1C28] mt-1">{errors.size}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="req-desired-date"
                className="block text-sm font-semibold text-[#14213D] mb-1.5"
              >
                التاريخ الذي تريد وصول العطر فيه
              </label>
              <input
                id="req-desired-date"
                type="date"
                value={desiredDate}
                onChange={(e) => setDesiredDate(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg tabular-nums focus:outline-2 focus:outline-[#6B1D2F]"
              />
              {errors.desiredDate && (
                <p className="text-xs text-[#9E1C28] mt-1">{errors.desiredDate}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="req-customer-name"
                className="block text-sm font-semibold text-[#14213D] mb-1.5"
              >
                اسمك الكريم
              </label>
              <input
                id="req-customer-name"
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="الاسم للتواصل"
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg focus:outline-2 focus:outline-[#6B1D2F]"
              />
              {errors.customerName && (
                <p className="text-xs text-[#9E1C28] mt-1">{errors.customerName}</p>
              )}
            </div>

            <div className="sm:col-span-2">
              <label
                htmlFor="req-customer-phone"
                className="block text-sm font-semibold text-[#14213D] mb-1.5"
              >
                رقم الهاتف للتواصل
              </label>
              <input
                id="req-customer-phone"
                type="tel"
                dir="ltr"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="077XXXXXXXX"
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg text-right tabular-nums focus:outline-2 focus:outline-[#6B1D2F]"
              />
              {errors.customerPhone && (
                <p className="text-xs text-[#9E1C28] mt-1">
                  {errors.customerPhone}
                </p>
              )}
            </div>

            <div className="sm:col-span-2">
              <label
                htmlFor="req-notes"
                className="block text-sm font-semibold text-[#14213D] mb-1.5"
              >
                ملاحظات إضافية (اختياري)
              </label>
              <input
                id="req-notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="تركيز معين أو تغليف هدية..."
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F5] border border-black/15 rounded-lg focus:outline-2 focus:outline-[#6B1D2F]"
              />
            </div>

            {serverError && (
              <div
                role="alert"
                className="sm:col-span-2 p-3 rounded-lg bg-[#FDF2F2] border border-[#9E1C28]/25 text-xs sm:text-sm text-[#9E1C28]"
              >
                {serverError}
              </div>
            )}

            {successMsg && (
              <div
                role="status"
                data-testid="custom-request-success"
                className="sm:col-span-2 p-4 rounded-lg bg-[#F0F7F4] border border-[#1E6B52]/25 text-xs sm:text-sm text-[#17523E] flex items-start gap-2.5"
              >
                <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{successMsg}</span>
              </div>
            )}

            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-white bg-[#6B1D2F] hover:bg-[#531523] disabled:opacity-50 rounded-lg transition-colors cursor-pointer min-h-[44px]"
              >
                <Send className="w-4 h-4" aria-hidden="true" />
                <span>
                  {submitting ? 'جاري إرسال طلبك...' : 'إرسال طلب «وفرلي عطري»'}
                </span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
