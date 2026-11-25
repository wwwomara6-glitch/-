import { Check, Plus, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  CATEGORY_LABELS,
  formatIQD,
  getProductSizeOptions,
  resolveProductUnitPrice,
  type Product,
} from '../utils/commerce';
import { SafeImage } from './SafeImage';

interface ProductDetailModalProps {
  product: Product | null;
  onClose: () => void;
  onAddToCart: (product: Product, selectedSize?: string) => void;
}

export function ProductDetailModal({
  product,
  onClose,
  onAddToCart,
}: ProductDetailModalProps) {
  const [selectedSize, setSelectedSize] = useState<string>('');

  useEffect(() => {
    if (product) {
      setSelectedSize(resolveProductUnitPrice(product).size);
    }
  }, [product]);

  if (!product) return null;

  const sizeOptions = getProductSizeOptions(product);
  const resolved = resolveProductUnitPrice(product, selectedSize);

  const isBottleStudioCard =
    product.imageUrl.startsWith('/assets/aistudio/') ||
    product.imageUrl.startsWith('/uploads/');

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="product-modal-title"
      onClick={onClose}
    >
      <div
        className="bg-[#FAF8F5] rounded-2xl border border-black/15 max-w-3xl w-full overflow-hidden shadow-xl grid grid-cols-1 md:grid-cols-2 my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Image Side */}
        <div
          className={`relative aspect-[4/3] md:aspect-auto flex items-center justify-center ${
            isBottleStudioCard ? 'bg-white p-4' : 'bg-[#F2EFE9]'
          }`}
        >
          <SafeImage
            src={product.imageUrl}
            alt={product.name}
            className={`w-full h-full ${
              isBottleStudioCard ? 'object-contain max-h-[380px]' : 'object-cover'
            }`}
            fallbackLabel={product.name}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق نافذة التفاصيل"
            className="md:hidden absolute top-3 left-3 w-10 h-10 rounded-full bg-white/90 text-[#12141A] flex items-center justify-center shadow"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Details Side */}
        <div className="p-6 sm:p-8 flex flex-col justify-between gap-6">
          <div>
            <div className="flex items-start justify-between gap-4">
              <div className="text-xs text-[#5A5E6B] tabular-nums">
                <span className="font-bold text-[#6B1D2F]">
                  رقم #{product.code}
                </span>
                <span className="mx-1.5" aria-hidden="true">·</span>
                <span>{product.brand}</span>
                <span className="mx-1.5" aria-hidden="true">·</span>
                <span>{CATEGORY_LABELS[product.category]}</span>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="إغلاق"
                className="hidden md:flex w-9 h-9 rounded-lg hover:bg-black/5 text-[#5A5E6B] items-center justify-center cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <h2
              id="product-modal-title"
              className="font-display text-2xl sm:text-3xl font-bold text-[#14213D] mt-2"
            >
              {product.name}
            </h2>

            <p className="text-xl font-bold text-[#6B1D2F] mt-2 tabular-nums">
              {formatIQD(resolved.priceIqd)}
            </p>

            {sizeOptions.length > 1 && (
              <div className="mt-3 space-y-1.5">
                <p className="text-xs font-semibold text-[#14213D]">
                  اختر الحجم المطلوب:
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {sizeOptions.map((opt) => {
                    const isSelected = resolved.size === opt.size;
                    return (
                      <button
                        key={opt.size}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedSize(opt.size)}
                        className={`py-2 px-2.5 rounded-lg border text-center transition-colors cursor-pointer tabular-nums ${
                          isSelected
                            ? 'bg-[#14213D] text-white border-[#14213D]'
                            : 'bg-white text-[#14213D] border-black/15 hover:border-[#6B1D2F]'
                        }`}
                      >
                        <span className="block text-xs font-bold">
                          {opt.size}
                        </span>
                        <span
                          className={`block text-[11px] mt-0.5 ${
                            isSelected ? 'text-[#E8CFA0]' : 'text-[#5A5E6B]'
                          }`}
                        >
                          {formatIQD(opt.priceIqd)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <p className="text-sm text-[#454954] mt-3 leading-relaxed">
              {product.description}
            </p>

            <dl className="mt-5 pt-4 border-t border-black/10 grid grid-cols-2 gap-3 text-xs sm:text-sm">
              <div>
                <dt className="text-[#5A5E6B]">الحجم المختار</dt>
                <dd className="font-semibold text-[#12141A] mt-0.5">
                  {resolved.size}
                </dd>
              </div>
              <div>
                <dt className="text-[#5A5E6B]">الثبات والفوحان</dt>
                <dd className="font-semibold text-[#12141A] mt-0.5">
                  {product.longevity} · {product.sillage}
                </dd>
              </div>

              {product.topNotes || product.heartNotes || product.baseNotes ? (
                <div className="col-span-2 mt-1 p-3.5 rounded-xl bg-white border border-black/10 space-y-2">
                  <p className="text-xs font-bold text-[#6B1D2F]">
                    الهرم العطري (النوتات)
                  </p>
                  {product.topNotes && (
                    <div>
                      <dt className="text-xs text-[#5A5E6B]">
                        النوتات العليا (الافتتاحية)
                      </dt>
                      <dd className="font-semibold text-[#14213D] text-xs sm:text-sm">
                        {product.topNotes}
                      </dd>
                    </div>
                  )}
                  {product.heartNotes && (
                    <div>
                      <dt className="text-xs text-[#5A5E6B]">
                        النوتات الوسطى (قلب العطر)
                      </dt>
                      <dd className="font-semibold text-[#14213D] text-xs sm:text-sm">
                        {product.heartNotes}
                      </dd>
                    </div>
                  )}
                  {product.baseNotes && (
                    <div>
                      <dt className="text-xs text-[#5A5E6B]">
                        النوتات الأساسية (القاعدة)
                      </dt>
                      <dd className="font-semibold text-[#14213D] text-xs sm:text-sm">
                        {product.baseNotes}
                      </dd>
                    </div>
                  )}
                </div>
              ) : (
                <div className="col-span-2">
                  <dt className="text-[#5A5E6B]">النفحات العطرية</dt>
                  <dd className="font-semibold text-[#12141A] mt-0.5">
                    {product.notes}
                  </dd>
                </div>
              )}
            </dl>

            {product.includesFreeTester && (
              <div className="mt-4 p-3 rounded-lg bg-[#F2EFE9] border border-black/8 flex items-start gap-2.5 text-xs text-[#14213D]">
                <ShieldCheck
                  className="w-4 h-4 text-[#A67C37] shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <span>
                  يشمل هذا العطر{' '}
                  <strong>تيستر مجاني للتجربة</strong> مع ضمان الثبات والفوحان
                  من وكالة بلوكرانا.
                </span>
              </div>
            )}

            {(product.category === 'blaugrana' ||
              product.category === 'other_brands') && (
              <div className="mt-2 flex items-center gap-2 text-xs text-[#6B1D2F] font-medium">
                <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>مشمول في قسيمة الولاء: اشترِ 4 عطور والخامس مجاني</span>
              </div>
            )}
          </div>

          <button
            type="button"
            disabled={!product.inStock}
            onClick={() => {
              onAddToCart(product, resolved.size);
              onClose();
            }}
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] disabled:opacity-45 rounded-lg transition-colors cursor-pointer min-h-[44px]"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>
              {product.inStock
                ? `أضف (${resolved.size}) إلى السلة`
                : 'غير متوفر حالياً'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
