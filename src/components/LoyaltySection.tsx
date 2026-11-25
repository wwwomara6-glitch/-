import { Gift, Search, Ticket } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { apiUrl, isMaintenanceResponse, warmApiServer } from '../lib/apiClient';
import type { LoyaltyProfile } from '../utils/commerce';

interface LoyaltySectionProps {
  currentCartPerfumeCount: number;
}

export function LoyaltySection({
  currentCartPerfumeCount,
}: LoyaltySectionProps) {
  const [phoneInput, setPhoneInput] = useState('');
  const [profile, setProfile] = useState<LoyaltyProfile | null>(null);
  const [lookupError, setLookupError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLookup = async (e: FormEvent) => {
    e.preventDefault();
    setLookupError('');
    setLoading(true);
    try {
      const res = await fetch(
        apiUrl(`/api/loyalty/${encodeURIComponent(phoneInput.trim())}`)
      );
      const data = (await res.json()) as {
        loyalty?: LoyaltyProfile;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.loyalty) {
        setLookupError(
          isMaintenanceResponse(res.status, data)
            ? data.error ?? 'الخدمة في وضع الصيانة المؤقتة حالياً.'
            : data.error ?? 'يرجى إدخال رقم هاتف صحيح.'
        );
        setProfile(null);
        return;
      }
      setProfile(data.loyalty);
    } catch {
      setLookupError('تعذر الاتصال بالخادم، حاول مجدداً.');
    } finally {
      setLoading(false);
    }
  };

  const activeStamps = profile
    ? (profile.totalQualifyingPerfumes + currentCartPerfumeCount) % 5
    : currentCartPerfumeCount % 5;

  const isFifthUnlocked =
    (profile ? profile.totalQualifyingPerfumes : 0) + currentCartPerfumeCount >=
    5;

  return (
    <section id="loyalty" className="scroll-mt-20 py-16 bg-[#FAF8F5]">
      <div className="max-w-7xl mx-auto px-4 sm:px-8">
        <div className="bg-[#14213D] text-white rounded-2xl p-6 sm:p-10 lg:p-12 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
          {/* Explanation + Phone Check */}
          <div className="lg:col-span-7 space-y-5">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-[#E8CFA0]">
              <Ticket className="w-4 h-4" aria-hidden="true" />
              <span>قسيمة الولاء الخاصة لزبائن بلوكرانا</span>
            </div>

            <h2 className="font-display text-3xl sm:text-4xl font-bold text-white text-balance">
              اشترِ 4 عطور واحصل على العطر الخامس مجاناً
            </h2>

            <p className="text-sm sm:text-base text-white/80 leading-relaxed max-w-2xl">
              كل زبون في وكالة بلوكرانا يحصل تلقائياً على قسيمة خاصة مرتبطة
              برقم هاتفه. سواء اشتريت 4 عطور في طلب واحد أو على عدة طلبات، يكون
              العطر الخامس مجانياً بالكامل وتُطبّق القسيمة مباشرة في سلتك.
            </p>

            <form
              onSubmit={handleLookup}
              className="flex flex-col sm:flex-row gap-3 pt-2 max-w-md"
            >
              <label htmlFor="loyalty-phone-lookup" className="sr-only">
                استعلم برقم الهاتف
              </label>
              <input
                id="loyalty-phone-lookup"
                type="tel"
                dir="ltr"
                value={phoneInput}
                onFocus={() => void warmApiServer()}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="أدخل رقم هاتفك للتحقق من أختامك (077...)"
                className="flex-1 px-4 py-2.5 text-sm rounded-lg bg-white text-[#12141A] placeholder:text-[#6C707D] text-right tabular-nums focus:outline-2 focus:outline-[#E8CFA0]"
              />
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold bg-[#A67C37] hover:bg-[#8E682B] text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer min-h-[42px]"
              >
                <Search className="w-4 h-4" aria-hidden="true" />
                <span>{loading ? 'جاري الفحص...' : 'تحقق من القسيمة'}</span>
              </button>
            </form>

            {lookupError && (
              <p className="text-xs text-[#FCA5A5]">{lookupError}</p>
            )}

            {profile && (
              <div className="p-4 rounded-xl bg-white/10 border border-white/15 text-xs sm:text-sm space-y-1">
                <p className="font-semibold text-[#E8CFA0]">
                  رقم القسيمة الخاصة بك:{' '}
                  <span className="tabular-nums font-mono" dir="ltr">
                    {profile.voucherCode}
                  </span>
                </p>
                <p className="text-white/90">
                  مجموع العطور المشتراة سابقاً:{' '}
                  <strong className="tabular-nums">
                    {profile.totalQualifyingPerfumes}
                  </strong>{' '}
                  · الهدايا المجانية المستلمة:{' '}
                  <strong className="tabular-nums">
                    {profile.freePerfumesRedeemed}
                  </strong>
                </p>
              </div>
            )}
          </div>

          {/* Visual 5-Stamp Voucher Card */}
          <div className="lg:col-span-5 bg-[#FAF8F5] text-[#12141A] rounded-2xl p-6 border border-white/20">
            <div className="flex items-center justify-between pb-4 border-b border-black/10">
              <div>
                <p className="text-xs font-semibold text-[#6B1D2F]">
                  بطاقة القسيمة الخاصة
                </p>
                <p className="font-display text-xl font-bold text-[#14213D]">
                  قسيمة 4 + 1 مجاني
                </p>
              </div>
              <span className="text-xs font-mono font-bold text-[#14213D] tabular-nums">
                {profile ? profile.voucherCode : 'BG-VIP'}
              </span>
            </div>

            <div className="grid grid-cols-5 gap-2.5 my-6">
              {[1, 2, 3, 4, 5].map((slot) => {
                const isFreeSlot = slot === 5;
                const filled = isFreeSlot
                  ? isFifthUnlocked
                  : activeStamps >= slot || isFifthUnlocked;
                return (
                  <div
                    key={slot}
                    className={`aspect-square rounded-xl border flex flex-col items-center justify-center text-center p-1 transition-colors ${
                      isFreeSlot
                        ? filled
                          ? 'bg-[#6B1D2F] border-[#6B1D2F] text-white'
                          : 'bg-[#F2EFE9] border-dashed border-[#6B1D2F]/50 text-[#6B1D2F]'
                        : filled
                          ? 'bg-[#14213D] border-[#14213D] text-white'
                          : 'bg-[#F2EFE9] border-black/15 text-[#5A5E6B]'
                    }`}
                  >
                    {isFreeSlot ? (
                      <>
                        <Gift className="w-4 h-4 mb-0.5" aria-hidden="true" />
                        <span className="text-[11px] font-bold">مجاني</span>
                      </>
                    ) : (
                      <>
                        <span className="text-sm font-bold tabular-nums">
                          {slot}
                        </span>
                        <span className="text-[10px]">
                          {filled ? 'مختوم' : 'عطر'}
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-[#454954] leading-relaxed">
              {isFifthUnlocked
                ? 'مبارك! وصلت إلى 5 عطور وتستحق عطراً مجانياً في هذا الطلب.'
                : `متبقي لك ${Math.max(1, 5 - activeStamps - 1)} عطور مدفوعة، والعطر الخامس يكون مجانياً بالكامل.`}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
