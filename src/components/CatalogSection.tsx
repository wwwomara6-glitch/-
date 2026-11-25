import { Eye, Plus, Search, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  CATEGORY_LABELS,
  NOTE_FAMILIES,
  compareProductsByCode,
  formatIQD,
  getProductSizeOptions,
  matchesNoteFamily,
  resolveProductUnitPrice,
  type NoteFamilyId,
  type Product,
  type ProductCategory,
} from '../utils/commerce';
import { SafeImage } from './SafeImage';

interface CatalogSectionProps {
  products: Product[];
  onAddToCart: (product: Product, selectedSize?: string) => void;
  onSelectProduct: (product: Product) => void;
}

type CategoryFilter = 'all' | ProductCategory;
type SortMode = 'code_asc' | 'price_asc' | 'price_desc' | 'name_asc';

const CATEGORY_TABS: Array<{ id: CategoryFilter; label: string }> = [
  { id: 'all', label: 'جميع المنتجات' },
  { id: 'blaugrana', label: 'عطور بلوكرانا المرقمة' },
  { id: 'other_brands', label: 'عطور شركات أخرى' },
  { id: 'body_mist', label: 'معطرات الجسم والبخاخات' },
  { id: 'room_spray', label: 'معطرات الجو والأقمشة' },
  { id: 'deodorant', label: 'مزيلات العرق' },
  { id: 'hair_care', label: 'شامبو هير وعناية بالشعر' },
  { id: 'tester', label: 'تيسترات التجربة' },
];

export function CatalogSection({
  products,
  onAddToCart,
  onSelectProduct,
}: CatalogSectionProps) {
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>('all');
  const [selectedBrand, setSelectedBrand] = useState<string>('all');
  const [activeNoteFamily, setActiveNoteFamily] =
    useState<NoteFamilyId>('all');
  const [sortBy, setSortBy] = useState<SortMode>('code_asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSizes, setSelectedSizes] = useState<Record<string, string>>(
    {}
  );

  const availableBrands = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      if (activeCategory === 'all' || p.category === activeCategory) {
        if (p.brand) set.add(p.brand);
      }
    }
    return Array.from(set);
  }, [products, activeCategory]);

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const qCompact = q.replace(/[\-\s]+/g, '');
    const list = products.filter((p) => {
      if (activeCategory !== 'all' && p.category !== activeCategory) {
        return false;
      }
      if (selectedBrand !== 'all' && p.brand !== selectedBrand) {
        return false;
      }
      if (!matchesNoteFamily(p, activeNoteFamily)) {
        return false;
      }
      if (!q) return true;
      const codeLower = p.code.toLowerCase();
      const nameLower = p.name.toLowerCase();
      return (
        nameLower.includes(q) ||
        codeLower.includes(q) ||
        (qCompact.length >= 2 &&
          (codeLower.replace(/[\-\s]+/g, '').includes(qCompact) ||
            nameLower.replace(/[\-\s]+/g, '').includes(qCompact))) ||
        p.brand.toLowerCase().includes(q) ||
        p.notes.toLowerCase().includes(q) ||
        (p.topNotes ?? '').toLowerCase().includes(q) ||
        (p.heartNotes ?? '').toLowerCase().includes(q) ||
        (p.baseNotes ?? '').toLowerCase().includes(q)
      );
    });

    const sorted = [...list];
    if (sortBy === 'code_asc') {
      sorted.sort(compareProductsByCode);
    } else if (sortBy === 'price_asc') {
      sorted.sort((a, b) => a.priceIqd - b.priceIqd || compareProductsByCode(a, b));
    } else if (sortBy === 'price_desc') {
      sorted.sort((a, b) => b.priceIqd - a.priceIqd || compareProductsByCode(a, b));
    } else if (sortBy === 'name_asc') {
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    }
    return sorted;
  }, [
    products,
    activeCategory,
    selectedBrand,
    activeNoteFamily,
    sortBy,
    searchQuery,
  ]);

  const handleCategoryChange = (cat: CategoryFilter) => {
    setActiveCategory(cat);
    setSelectedBrand('all');
  };

  return (
    <section id="catalog" className="scroll-mt-20 py-14 bg-[#FAF8F5]">
      <div className="max-w-7xl mx-auto px-4 sm:px-8">
        {/* Section Header + Search + Sort */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-8 border-b border-black/10">
          <div>
            <p className="text-xs font-semibold text-[#6B1D2F]">
              دليل العطور والمنتجات المرقّمة ({filteredProducts.length})
            </p>
            <h2 className="font-display text-3xl sm:text-4xl font-bold text-[#14213D] mt-1">
              مجموعة بلوكرانا والشركات العالمية
            </h2>
            <p className="text-sm sm:text-base text-[#5A5E6B] mt-2 max-w-2xl">
              ابحث برقم العطر (M01 – M65 أو إيفل M-1)، اسمه (هوس، مسك إبراهيم القرشي، كايالي، قصة، عساف، شامبو هير)، أو نوتاته العطرية. جميع العطور مشمولة بتيستر مجاني وضمان الثبات والفوحان.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full lg:w-auto">
            <div className="relative flex-1 sm:w-64">
              <label htmlFor="catalog-search" className="sr-only">
                ابحث باسم العطر أو رقمه أو النوتات
              </label>
              <Search
                className="w-4 h-4 text-[#5A5E6B] absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="catalog-search"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ابحث بالرقم (M01) أو الاسم أو النوتة..."
                className="w-full pr-10 pl-4 py-2.5 text-sm bg-white border border-black/15 rounded-lg text-[#12141A] placeholder:text-[#7A7E8A] focus:outline-2 focus:outline-[#6B1D2F]"
              />
            </div>

            <div className="sm:w-52">
              <label htmlFor="sort-filter" className="sr-only">
                ترتيب العطور
              </label>
              <select
                id="sort-filter"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortMode)}
                className="w-full ps-3 pe-8 py-2.5 text-sm bg-white border border-black/15 rounded-lg text-[#12141A] focus:outline-2 focus:outline-[#6B1D2F]"
              >
                <option value="code_asc">ترتيب بالرقم (M01 - M65)</option>
                <option value="price_asc">السعر: الأقل أولاً</option>
                <option value="price_desc">السعر: الأعلى أولاً</option>
                <option value="name_asc">الاسم: أ - ي</option>
              </select>
            </div>

            {availableBrands.length > 1 && (
              <div className="sm:w-44">
                <label htmlFor="brand-filter" className="sr-only">
                  تصفية حسب الشركة
                </label>
                <select
                  id="brand-filter"
                  value={selectedBrand}
                  onChange={(e) => setSelectedBrand(e.target.value)}
                  className="w-full ps-3 pe-8 py-2.5 text-sm bg-white border border-black/15 rounded-lg text-[#12141A] focus:outline-2 focus:outline-[#6B1D2F]"
                >
                  <option value="all">كل الشركات ({availableBrands.length})</option>
                  {availableBrands.map((brand) => (
                    <option key={brand} value={brand}>
                      {brand}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Category Segmented Controls */}
        <div
          role="tablist"
          aria-label="أقسام المتجر"
          className="flex flex-wrap items-center gap-2 pt-6 pb-3"
        >
          {CATEGORY_TABS.map((tab) => {
            const active = activeCategory === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => handleCategoryChange(tab.id)}
                className={`px-4 py-2 text-xs sm:text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer min-h-[40px] ${
                  active
                    ? 'bg-[#14213D] text-white'
                    : 'bg-[#F2EFE9] text-[#3B3F4A] hover:bg-[#E7E2D8] hover:text-[#12141A]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Fragrance Note Family Filter Bar */}
        <div
          role="group"
          aria-label="تصفية حسب النوتات العطرية"
          className="flex flex-wrap items-center gap-2 pb-6"
        >
          <span className="text-xs font-semibold text-[#5A5E6B] ml-1">
            النوتات العطرية:
          </span>
          {NOTE_FAMILIES.map((family) => {
            const active = activeNoteFamily === family.id;
            return (
              <button
                key={family.id}
                type="button"
                aria-pressed={active}
                onClick={() => setActiveNoteFamily(family.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-[#6B1D2F] text-white border-[#6B1D2F]'
                    : 'bg-white text-[#454954] border-black/12 hover:border-[#6B1D2F]/40 hover:text-[#14213D]'
                }`}
              >
                {family.label}
              </button>
            );
          })}
        </div>

        {/* Product Grid */}
        {filteredProducts.length === 0 ? (
          <div className="py-16 text-center bg-[#F2EFE9] rounded-2xl border border-black/10">
            <p className="font-display text-2xl font-bold text-[#14213D]">
              لم نعثر على عطر مطابق لبحثك
            </p>
            <p className="text-sm text-[#5A5E6B] mt-2">
              يمكنك طلب أي عطر غير موجود عبر ميزة{' '}
              <a
                href="#custom-request"
                className="text-[#6B1D2F] font-semibold underline underline-offset-4"
              >
                وفرلي عطري
              </a>{' '}
              وسنوفره لك خصيصاً.
            </p>
            <button
              type="button"
              onClick={() => {
                setActiveCategory('all');
                setSelectedBrand('all');
                setActiveNoteFamily('all');
                setSortBy('code_asc');
                setSearchQuery('');
              }}
              className="mt-4 px-5 py-2.5 text-sm font-semibold text-white bg-[#14213D] rounded-lg hover:bg-[#6B1D2F] transition-colors cursor-pointer"
            >
              عرض جميع المنتجات
            </button>
          </div>
        ) : (
          <div
            data-testid="product-grid"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8"
          >
            {filteredProducts.map((product) => {
              const isBottleStudioCard =
                product.imageUrl.startsWith('/assets/aistudio/') ||
                product.imageUrl.startsWith('/uploads/');
              const sizeOptions = getProductSizeOptions(product);
              const activeSize =
                selectedSizes[product.id] ??
                resolveProductUnitPrice(product).size;
              const resolved = resolveProductUnitPrice(product, activeSize);
              return (
                <article
                  key={product.id}
                  data-testid={`product-card-${product.code}`}
                  className="group bg-white rounded-xl border border-black/10 overflow-hidden flex flex-col transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-md"
                >
                  {/* 4:3 Image Container */}
                  <div
                    className={`relative aspect-[4/3] overflow-hidden ${
                      isBottleStudioCard
                        ? 'bg-white border-b border-black/6 p-2'
                        : 'bg-[#F2EFE9]'
                    }`}
                  >
                    <SafeImage
                      src={product.imageUrl}
                      alt={`${product.name} - رقم ${product.code}`}
                      className={`w-full h-full transition-transform duration-300 group-hover:scale-[1.03] ${
                        isBottleStudioCard ? 'object-contain' : 'object-cover'
                      }`}
                      fallbackLabel={product.name}
                    />
                    {!product.inStock && (
                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                        <span className="text-sm font-bold text-white bg-[#12141A]/90 px-4 py-1.5 rounded">
                          نفذت الكمية مؤقتاً
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Card Body */}
                  <div className="p-5 flex-1 flex flex-col justify-between gap-4">
                    <div>
                      {/* Unboxed Metadata (Zero-Pill Rule) */}
                      <div className="flex items-center flex-wrap gap-1.5 text-xs text-[#5A5E6B] tabular-nums">
                        <span className="font-bold text-[#6B1D2F]">
                          رقم #{product.code}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-medium text-[#14213D]">
                          {product.brand}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{resolved.size}</span>
                        <span aria-hidden="true">·</span>
                        <span>{CATEGORY_LABELS[product.category]}</span>
                      </div>

                      <h3 className="text-lg font-bold text-[#12141A] mt-2 leading-snug">
                        {product.name}
                      </h3>

                      {product.topNotes ||
                      product.heartNotes ||
                      product.baseNotes ? (
                        <div className="mt-2 space-y-1 text-xs text-[#5A5E6B] leading-relaxed">
                          {product.topNotes && (
                            <p className="line-clamp-1">
                              <span className="font-semibold text-[#14213D]">
                                الافتتاحية:{' '}
                              </span>
                              {product.topNotes}
                            </p>
                          )}
                          {product.heartNotes && (
                            <p className="line-clamp-1">
                              <span className="font-semibold text-[#14213D]">
                                القلب:{' '}
                              </span>
                              {product.heartNotes}
                            </p>
                          )}
                          {product.baseNotes && (
                            <p className="line-clamp-1">
                              <span className="font-semibold text-[#14213D]">
                                القاعدة:{' '}
                              </span>
                              {product.baseNotes}
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs sm:text-sm text-[#5A5E6B] mt-1.5 line-clamp-2 leading-relaxed">
                          {product.notes}
                        </p>
                      )}
                    </div>

                    <div className="pt-3 border-t border-black/8 space-y-3">
                      {sizeOptions.length > 1 && (
                        <div
                          role="group"
                          aria-label={`اختيار حجم ${product.name}`}
                          className="grid grid-cols-3 gap-1.5"
                        >
                          {sizeOptions.map((opt) => {
                            const isSelected = resolved.size === opt.size;
                            return (
                              <button
                                key={opt.size}
                                type="button"
                                aria-pressed={isSelected}
                                onClick={() =>
                                  setSelectedSizes((prev) => ({
                                    ...prev,
                                    [product.id]: opt.size,
                                  }))
                                }
                                className={`py-1.5 px-2 rounded-lg border text-center transition-colors cursor-pointer tabular-nums ${
                                  isSelected
                                    ? 'bg-[#14213D] text-white border-[#14213D]'
                                    : 'bg-[#FAF8F5] text-[#14213D] border-black/12 hover:border-[#6B1D2F]/50'
                                }`}
                              >
                                <span className="block text-[11px] font-bold leading-tight">
                                  {opt.size}
                                </span>
                                <span
                                  className={`block text-[10px] leading-tight mt-0.5 ${
                                    isSelected
                                      ? 'text-[#E8CFA0]'
                                      : 'text-[#5A5E6B]'
                                  }`}
                                >
                                  {opt.priceIqd.toLocaleString('en-US')} د.ع
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2 text-xs text-[#454954]">
                        <span>الثبات: {product.longevity}</span>
                        {product.includesFreeTester && (
                          <span className="inline-flex items-center gap-1 text-[#14213D] font-medium">
                            <ShieldCheck
                              className="w-3.5 h-3.5 text-[#A67C37]"
                              aria-hidden="true"
                            />
                            تيستر مجاني + ضمان
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-3">
                        <span className="text-base sm:text-lg font-bold text-[#14213D] tabular-nums">
                          {formatIQD(resolved.priceIqd)}
                        </span>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onSelectProduct(product)}
                            aria-label={`عرض تفاصيل ${product.name}`}
                            className="p-2.5 text-[#3B3F4A] bg-[#F2EFE9] hover:bg-[#E5E0D5] rounded-lg transition-colors cursor-pointer min-h-[40px] min-w-[40px] flex items-center justify-center"
                          >
                            <Eye className="w-4 h-4" aria-hidden="true" />
                          </button>

                          <button
                            type="button"
                            disabled={!product.inStock}
                            onClick={() => onAddToCart(product, resolved.size)}
                            aria-label={`إضافة ${product.name} رقم ${product.code} (${resolved.size}) إلى السلة`}
                            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] disabled:opacity-45 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer min-h-[40px]"
                          >
                            <Plus className="w-4 h-4" aria-hidden="true" />
                            <span>أضف للسلة</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
