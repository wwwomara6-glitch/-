import { ExternalLink, MapPin, Phone } from 'lucide-react';
import {
  sanitizeHref,
  type SocialLink,
  type StoreInfo,
} from '../utils/commerce';

interface FooterSectionProps {
  storeInfo: StoreInfo;
  socialLinks: SocialLink[];
  onOpenAdmin: () => void;
}

export function FooterSection({
  storeInfo,
  socialLinks,
  onOpenAdmin,
}: FooterSectionProps) {
  return (
    <footer
      id="location-contact"
      className="scroll-mt-20 bg-[#12141A] text-[#FAF8F5] border-t border-white/10"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-14 grid grid-cols-1 md:grid-cols-12 gap-10">
        {/* Brand & Location */}
        <div className="md:col-span-5 space-y-4">
          <h2 className="font-display text-3xl font-bold text-white">
            {storeInfo.agencyName}
          </h2>
          <p className="text-sm text-white/75 leading-relaxed max-w-md">
            {storeInfo.guaranteeText}
          </p>
          <div className="pt-2 flex items-start gap-2.5 text-sm text-[#E8CFA0]">
            <MapPin className="w-4 h-4 shrink-0 mt-1" aria-hidden="true" />
            <span>{storeInfo.locationText}</span>
          </div>
        </div>

        {/* Social Links */}
        <div className="md:col-span-5 space-y-4">
          <h3 className="text-sm font-bold text-white">
            تواصل معنا عبر منصاتنا الرسمية
          </h3>
          <ul className="space-y-2.5">
            {socialLinks.map((link) => {
              const safeUrl = sanitizeHref(link.url);
              return (
                <li key={link.id}>
                  <a
                    href={safeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2.5 text-sm text-white/85 hover:text-[#E8CFA0] transition-colors"
                  >
                    {link.platform.includes('واتساب') ? (
                      <Phone className="w-4 h-4 shrink-0" aria-hidden="true" />
                    ) : (
                      <ExternalLink
                        className="w-4 h-4 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span className="font-semibold">{link.label}:</span>
                    <span dir="ltr" className="tabular-nums text-white/70">
                      {link.handle}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Quick Links */}
        <div className="md:col-span-2 space-y-3">
          <h3 className="text-sm font-bold text-white">روابط سريعة</h3>
          <ul className="space-y-2 text-sm text-white/75">
            <li>
              <a href="#catalog" className="hover:text-white transition-colors">
                العطور المرقمة
              </a>
            </li>
            <li>
              <a
                href="#custom-request"
                className="hover:text-white transition-colors"
              >
                وفرلي عطري
              </a>
            </li>
            <li>
              <a href="#loyalty" className="hover:text-white transition-colors">
                قسيمة 4+1 مجاني
              </a>
            </li>
            <li>
              <a
                href="#track-order"
                className="hover:text-white transition-colors"
              >
                تتبع طلبك ووقت الوصول
              </a>
            </li>
            <li>
              <button
                type="button"
                onClick={onOpenAdmin}
                className="text-[#E8CFA0] hover:underline underline-offset-4 cursor-pointer"
              >
                دخول الإدارة الخاصة
              </button>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-white/55">
          <p>وكالة بلوكرانا للعطور · جميع الحقوق محفوظة</p>
          <p>توصيل مجاني للطلبات فوق 20,000 د.ع</p>
        </div>
      </div>
    </footer>
  );
}
