import { Menu, ShoppingBag, X } from 'lucide-react';
import { useState } from 'react';

interface NavbarProps {
  cartCount: number;
  onOpenCart: () => void;
  onOpenAdmin: () => void;
  isAdminView: boolean;
  onExitAdmin: () => void;
}

export function Navbar({
  cartCount,
  onOpenCart,
  onOpenAdmin,
  isAdminView,
  onExitAdmin,
}: NavbarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleNavClick = (sectionId: string) => {
    setMobileOpen(false);
    if (isAdminView) {
      onExitAdmin();
      setTimeout(() => {
        document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    } else {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <header className="sticky top-0 z-40 bg-[#FAF8F5]/95 backdrop-blur-sm border-b border-black/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Single-line Brand Wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            if (isAdminView) onExitAdmin();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className="font-display text-2xl font-bold text-[#14213D] whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[#6B1D2F] rounded"
        >
          بلوكرانا للعطور
        </a>

        {/* Zone 2: Clean Single-Line Nav Links */}
        <nav
          aria-label="التنقل الرئيسي"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-[#3B3F4A]"
        >
          <button
            type="button"
            onClick={() => handleNavClick('catalog')}
            className="hover:text-[#6B1D2F] hover:underline underline-offset-8 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            المجموعة
          </button>
          <button
            type="button"
            onClick={() => handleNavClick('custom-request')}
            className="hover:text-[#6B1D2F] hover:underline underline-offset-8 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            وفرلي عطري
          </button>
          <button
            type="button"
            onClick={() => handleNavClick('loyalty')}
            className="hover:text-[#6B1D2F] hover:underline underline-offset-8 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            قسيمة 4+1
          </button>
          <button
            type="button"
            onClick={() => handleNavClick('track-order')}
            className="hover:text-[#6B1D2F] hover:underline underline-offset-8 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            تتبع طلبك
          </button>
          <button
            type="button"
            onClick={() => handleNavClick('location-contact')}
            className="hover:text-[#6B1D2F] hover:underline underline-offset-8 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            موقعنا وتواصلنا
          </button>
          <button
            type="button"
            onClick={() => {
              setMobileOpen(false);
              onOpenAdmin();
            }}
            className={`hover:text-[#6B1D2F] hover:underline underline-offset-8 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              isAdminView ? 'text-[#6B1D2F] font-semibold underline' : ''
            }`}
          >
            الإدارة الخاصة
          </button>
        </nav>

        {/* Zone 3: Primary Action */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenCart}
            aria-label={`فتح سلة المشتريات (${cartCount} منتجات)`}
            data-testid="open-cart-button"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer min-h-[40px]"
          >
            <ShoppingBag className="w-4 h-4" aria-hidden="true" />
            <span>السلة</span>
            <span className="tabular-nums font-bold">({cartCount})</span>
          </button>

          <button
            type="button"
            onClick={() => setMobileOpen((prev) => !prev)}
            aria-expanded={mobileOpen}
            aria-label={mobileOpen ? 'إغلاق القائمة' : 'فتح القائمة'}
            className="md:hidden inline-flex items-center justify-center w-11 h-11 rounded-lg border border-black/10 text-[#14213D] hover:bg-black/5 cursor-pointer"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer Nav */}
      {mobileOpen && (
        <nav
          aria-label="قائمة الجوال"
          className="md:hidden border-t border-black/10 bg-[#FAF8F5] px-4 py-3 flex flex-col gap-1"
        >
          <button
            type="button"
            onClick={() => handleNavClick('catalog')}
            className="text-right py-2.5 px-3 text-sm font-medium text-[#12141A] hover:bg-black/5 rounded-lg"
          >
            المجموعة الكاملة
          </button>
          <button
            type="button"
            onClick={() => handleNavClick('custom-request')}
            className="text-right py-2.5 px-3 text-sm font-medium text-[#12141A] hover:bg-black/5 rounded-lg"
          >
            وفرلي عطري
          </button>
          <button
            type="button"
            onClick={() => handleNavClick('loyalty')}
            className="text-right py-2.5 px-3 text-sm font-medium text-[#12141A] hover:bg-black/5 rounded-lg"
          >
            قسيمة الولاء 4+1 مجاني
          </button>
          <button
            type="button"
            onClick={() => handleNavClick('track-order')}
            className="text-right py-2.5 px-3 text-sm font-medium text-[#12141A] hover:bg-black/5 rounded-lg"
          >
            تتبع طلبك ووقت الوصول
          </button>
          <button
            type="button"
            onClick={() => handleNavClick('location-contact')}
            className="text-right py-2.5 px-3 text-sm font-medium text-[#12141A] hover:bg-black/5 rounded-lg"
          >
            موقعنا وتواصلنا
          </button>
          <button
            type="button"
            onClick={() => {
              setMobileOpen(false);
              onOpenAdmin();
            }}
            className="text-right py-2.5 px-3 text-sm font-semibold text-[#6B1D2F] hover:bg-black/5 rounded-lg"
          >
            الإدارة الخاصة
          </button>
        </nav>
      )}
    </header>
  );
}
