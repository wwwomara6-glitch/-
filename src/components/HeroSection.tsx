import { ArrowDownLeft, ShieldCheck } from 'lucide-react';
import type { StoreInfo } from '../utils/commerce';
import { SafeImage } from './SafeImage';

interface HeroSectionProps {
  storeInfo: StoreInfo;
  onExploreCatalog: () => void;
  onOpenCustomRequest: () => void;
}

export function HeroSection({
  storeInfo,
  onExploreCatalog,
  onOpenCustomRequest,
}: HeroSectionProps) {
  return (
    <section id="top" className="border-b border-black/10 bg-[#FAF8F5]">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 pt-10 pb-12 lg:pt-14 lg:pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-stretch">
          {/* Editorial Copy Column */}
          <div className="lg:col-span-6 flex flex-col justify-center space-y-6">
            <p className="text-xs sm:text-sm font-semibold text-[#6B1D2F] tracking-wide">
              {storeInfo.agencyName} · {storeInfo.city}
            </p>

            <h1 className="font-display text-4xl sm:text-5xl lg:text-[3.4rem] font-bold leading-[1.2] text-[#14213D] text-balance">
              عطورٌ تُروى برقمها، وتدوم بثباتها وفوحانها
            </h1>

            <p className="text-base sm:text-lg text-[#454954] leading-relaxed max-w-xl">
              مجموعتنا المرقّمة من عطور بلوكرانا وأرقى الدور العالمية، مع معطرات
              الجسم ومزيلات العرق. كل عطر تطلبه يصلك مع{' '}
              <strong className="font-semibold text-[#12141A]">
                تيستر مجاني للتجربة
              </strong>{' '}
              قبل فتح العبوة، بضمان الثبات والفوحان الذهبي.
            </p>

            <div className="flex flex-wrap items-center gap-4 pt-2">
              <button
                type="button"
                onClick={onExploreCatalog}
                className="inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold text-white bg-[#6B1D2F] hover:bg-[#531523] rounded-lg transition-colors cursor-pointer min-h-[44px]"
              >
                <span>تصفح العطور المرقمة</span>
                <ArrowDownLeft className="w-4 h-4" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={onOpenCustomRequest}
                className="inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold text-[#14213D] border border-[#14213D]/25 hover:border-[#14213D] hover:bg-[#14213D]/5 rounded-lg transition-colors cursor-pointer min-h-[44px]"
              >
                <span>اطلب عبر ميزة وفرلي عطري</span>
              </button>
            </div>

            <div className="pt-2 flex items-center gap-2 text-xs sm:text-sm text-[#5A5E6B]">
              <ShieldCheck
                className="w-4 h-4 text-[#A67C37] shrink-0"
                aria-hidden="true"
              />
              <span>{storeInfo.locationText}</span>
            </div>
          </div>

          {/* Visual Showcase Column */}
          <div className="lg:col-span-6 relative rounded-2xl overflow-hidden border border-black/10 min-h-[300px] sm:min-h-[380px] lg:min-h-[440px]">
            <SafeImage
              src="/src/assets/images/hero_blaugrana_perfume_1795208162240.jpg"
              alt="زجاجات عطور وكالة بلوكرانا الفاخرة باللونين الكحلي والعنابي"
              className="w-full h-full object-cover lg:h-full"
              fallbackLabel="وكالة بلوكرانا للعطور"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent pointer-events-none" />
            <div className="absolute bottom-0 inset-x-0 p-6 text-white">
              <p className="text-xs text-[#E8CFA0] font-medium">
                الإصدار الرسمي · ضمان الثبات والفوحان
              </p>
              <p className="font-display text-xl sm:text-2xl font-bold mt-1">
                اختر عطرك بالرقم، وجرّب التيستر المجاني أولاً
              </p>
            </div>
          </div>
        </div>

        {/* Full-Width 4-Column Service & Guarantee Strip */}
        <div className="mt-10 pt-8 border-t border-black/10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div>
            <p className="text-xs font-semibold text-[#6B1D2F]">01. تجربة مضمونة</p>
            <h2 className="font-sans text-base font-bold text-[#14213D] mt-1">
              تيستر مجاني مع كل عطر
            </h2>
            <p className="text-sm text-[#5A5E6B] mt-1 leading-relaxed">
              تصل عينة مجانية مع كل عطر لاختبار الرائحة قبل فتح العلبة الأصلية.
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold text-[#6B1D2F]">02. الجودة والأصل</p>
            <h2 className="font-sans text-base font-bold text-[#14213D] mt-1">
              ضمان الثبات والفوحان
            </h2>
            <p className="text-sm text-[#5A5E6B] mt-1 leading-relaxed">
              تركيز عالٍ وفوحان معتمد يدوم حتى 24 ساعة مع ضمان حقيقي من الوكالة.
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold text-[#6B1D2F]">03. قسيمة الولاء</p>
            <h2 className="font-sans text-base font-bold text-[#14213D] mt-1">
              اشترِ 4 عطور والخامس مجاني
            </h2>
            <p className="text-sm text-[#5A5E6B] mt-1 leading-relaxed">
              كل زبون يحصل على قسيمة خاصة تُحتسب تلقائياً برقم الهاتف في السلة.
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold text-[#6B1D2F]">04. التوصيل السريع</p>
            <h2 className="font-sans text-base font-bold text-[#14213D] mt-1">
              توصيل مجاني فوق 20,000 د.ع
            </h2>
            <p className="text-sm text-[#5A5E6B] mt-1 leading-relaxed">
              توصيل مجاني لأي طلب بقيمة 20,000 دينار عراقي فما فوق.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
