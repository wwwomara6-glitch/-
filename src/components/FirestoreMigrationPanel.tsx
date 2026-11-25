import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  Database,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildCatalogMigrationPlan,
  executeSafeCatalogMigrationWithWriteBatch,
  inspectExistingMigrationDocs,
  verifyMigratedCatalogInFirestore,
  type MigrationExecutionResult,
  type MigrationPostVerificationResult,
  type MigrationPreInspectionResult,
} from '../lib/catalogMigration';
import {
  AUTHORIZED_ADMIN_EMAIL,
  signInAdminWithGoogle,
  signOutAdmin,
  subscribeAdminAuth,
} from '../lib/firebase';
import type { Product, SocialLink, StoreInfo } from '../utils/commerce';

interface FirestoreMigrationPanelProps {
  storeInfo: StoreInfo;
  products: Product[];
  socialLinks: SocialLink[];
  onMigrationCompleted?: () => Promise<void>;
}

const MIGRATION_VERSION = 'v1.0.0-initial';

export function FirestoreMigrationPanel({
  storeInfo,
  products,
  socialLinks,
  onMigrationCompleted,
}: FirestoreMigrationPanelProps) {
  const [authReady, setAuthReady] = useState(false);
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [isOwnerVerified, setIsOwnerVerified] = useState(false);

  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  const [inspectBusy, setInspectBusy] = useState(false);
  const [preInspection, setPreInspection] =
    useState<MigrationPreInspectionResult | null>(null);

  const [migrateBusy, setMigrateBusy] = useState(false);
  const [migrationError, setMigrationError] = useState('');
  const [executionResult, setExecutionResult] =
    useState<MigrationExecutionResult | null>(null);
  const [postVerification, setPostVerification] =
    useState<MigrationPostVerificationResult | null>(null);

  const plan = useMemo(
    () =>
      buildCatalogMigrationPlan(
        {
          storeInfo,
          socialLinks,
          products,
        },
        {
          version: MIGRATION_VERSION,
          generatedAt: new Date().toISOString(),
        }
      ),
    [storeInfo, socialLinks, products]
  );

  const lastAutoInspectedUidRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeAdminAuth(({ ready, user, isAdmin }) => {
      setAuthReady(ready);
      setGoogleUser(user);
      setIsOwnerVerified(isAdmin);
      if (!isAdmin) {
        setPreInspection(null);
        lastAutoInspectedUidRef.current = null;
      }
    });
    return () => unsubscribe();
  }, []);

  const runReadOnlyPreInspection = useCallback(async () => {
    if (!isOwnerVerified || !googleUser) return;
    setInspectBusy(true);
    setMigrationError('');
    try {
      const inspection = await inspectExistingMigrationDocs(plan, {
        user: googleUser,
      });
      setPreInspection(inspection);
    } catch (err) {
      setMigrationError(
        err instanceof Error ? err.message : 'تعذر فحص المستندات في Firestore.'
      );
    } finally {
      setInspectBusy(false);
    }
  }, [isOwnerVerified, googleUser, plan]);

  // Strictly READ-ONLY pre-inspection once verified owner signs in (never writes automatically)
  useEffect(() => {
    if (
      isOwnerVerified &&
      googleUser &&
      lastAutoInspectedUidRef.current !== googleUser.uid
    ) {
      lastAutoInspectedUidRef.current = googleUser.uid;
      void runReadOnlyPreInspection();
    }
  }, [isOwnerVerified, googleUser, runReadOnlyPreInspection]);

  const handleGoogleLogin = async () => {
    setAuthBusy(true);
    setAuthError('');
    setMigrationError('');
    try {
      await signInAdminWithGoogle();
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code ?? '')
          : '';
      if (code === 'auth/popup-blocked') {
        setAuthError(
          'تم حظر نافذة تسجيل دخول Google من المتصفح أو داخل الإطار المدمج (iframe). اسمح بالنوافذ المنبثقة أو افتح رابط لوحة الإدارة في تبويب متصفح مستقل ثم أعد المحاولة.'
        );
      } else if (
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request'
      ) {
        setAuthError(
          'تم إغلاق نافذة تسجيل دخول Google قبل إكمال التحقق. يرجى المحاولة مرة أخرى.'
        );
      } else if (code === 'auth/unauthorized-domain') {
        setAuthError(
          'هذا النطاق غير مضاف في Authorized Domains داخل إعدادات Firebase Authentication.'
        );
      } else {
        setAuthError(
          err instanceof Error
            ? err.message
            : 'فشل تسجيل الدخول بحساب Google الموثق.'
        );
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const handleGoogleLogout = async () => {
    setAuthBusy(true);
    setAuthError('');
    try {
      await signOutAdmin();
      setPreInspection(null);
      setExecutionResult(null);
      setPostVerification(null);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleExecuteMigration = async () => {
    if (!isOwnerVerified || !googleUser || !plan.readyForExecution) return;
    setMigrateBusy(true);
    setMigrationError('');
    setExecutionResult(null);
    setPostVerification(null);

    try {
      const result = await executeSafeCatalogMigrationWithWriteBatch(plan, {
        user: googleUser,
        overwriteExisting: false,
      });
      setExecutionResult(result);

      const verification = await verifyMigratedCatalogInFirestore(plan, {
        user: googleUser,
      });
      setPostVerification(verification);

      const refreshedInspection = await inspectExistingMigrationDocs(plan, {
        user: googleUser,
      });
      setPreInspection(refreshedInspection);

      if (onMigrationCompleted && result.writtenCount > 0) {
        await onMigrationCompleted();
      }
    } catch (err) {
      setMigrationError(
        err instanceof Error ? err.message : 'تعذر إتمام عملية الترحيل السحابي.'
      );
    } finally {
      setMigrateBusy(false);
    }
  };

  const canTriggerMigration =
    isOwnerVerified &&
    Boolean(googleUser) &&
    plan.readyForExecution &&
    preInspection !== null &&
    !inspectBusy &&
    !migrateBusy;

  return (
    <div
      id="firestore-migration-panel"
      className="bg-white rounded-2xl border border-black/10 p-6 space-y-5 scroll-mt-24"
    >
      {/* Header + Google Owner Sign-In Control */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-black/10">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#14213D] text-[#E8CFA0] flex items-center justify-center shrink-0">
            <Database className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-[#14213D]">
              الترحيل الآمن للكتالوج إلى Firebase Firestore (Spark المجاني)
            </h2>
            <p className="text-xs text-[#5A5E6B] mt-1 leading-relaxed">
              ينقل البيانات العامة للكتالوج فقط باستخدام{' '}
              <span className="font-semibold text-[#14213D]">WriteBatch</span>{' '}
              من حساب المالك الموثق حصراً ({AUTHORIZED_ADMIN_EMAIL})، بدون استبدال
              المستندات الموجودة وبدون نقل أي بيانات حساسة.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {!authReady ? (
            <span className="text-xs text-[#5A5E6B]">جاري فحص جلسة Google...</span>
          ) : isOwnerVerified && googleUser ? (
            <>
              <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#F0F7F4] border border-[#1E6B52]/25 text-xs text-[#17523E]">
                <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span dir="ltr" className="font-semibold">
                  {googleUser.email}
                </span>
              </div>
              <button
                type="button"
                onClick={handleGoogleLogout}
                disabled={authBusy || migrateBusy}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#9E1C28] border border-[#9E1C28]/25 hover:bg-[#FDF2F2] disabled:opacity-50 rounded-lg cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                <span>خروج Google</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="firestore-google-login-button"
              onClick={handleGoogleLogin}
              disabled={authBusy}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] disabled:opacity-50 rounded-lg cursor-pointer transition-colors"
            >
              <ShieldCheck className="w-4 h-4 text-[#E8CFA0]" aria-hidden="true" />
              <span>
                {authBusy
                  ? 'جاري تسجيل الدخول...'
                  : 'تسجيل دخول Google للمالك (wwwomara6@gmail.com)'}
              </span>
            </button>
          )}
        </div>
      </div>

      {authError && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-[#FDF2F2] border border-[#9E1C28]/25 text-xs text-[#9E1C28] flex items-center gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{authError}</span>
        </div>
      )}

      {/* Pre-Execution Summary Grid (232 docs, 229 products, skipped existing) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 tabular-nums">
        <div className="p-3.5 rounded-xl bg-[#FAF8F5] border border-black/10">
          <p className="text-[11px] text-[#5A5E6B]">إجمالي المستندات المخططة</p>
          <p className="text-xl font-bold text-[#14213D] mt-1">
            {plan.totalFirestoreWritesPlanned} مستنداً
          </p>
          <p className="text-[11px] text-[#5A5E6B] mt-0.5">
            229 منتج + 2 شريحة + 1 ميتا
          </p>
        </div>

        <div className="p-3.5 rounded-xl bg-[#FAF8F5] border border-black/10">
          <p className="text-[11px] text-[#5A5E6B]">عدد المنتجات العامة</p>
          <p className="text-xl font-bold text-[#14213D] mt-1">
            {plan.includedDataSummary.productsCount} منتجاً
          </p>
          <p className="text-[11px] text-[#5A5E6B] mt-0.5">
            إصدار {plan.version}
          </p>
        </div>

        <div className="p-3.5 rounded-xl bg-[#FAF8F5] border border-black/10">
          <p className="text-[11px] text-[#5A5E6B]">
            مستندات موجودة سيتم تخطيها
          </p>
          <p className="text-xl font-bold text-[#6B1D2F] mt-1">
            {isOwnerVerified
              ? inspectBusy
                ? 'جاري الفحص...'
                : preInspection
                  ? `${preInspection.existingDocsCount} مستنداً`
                  : '—'
              : 'سجّل الدخول للفحص'}
          </p>
          <p className="text-[11px] text-[#5A5E6B] mt-0.5">
            وضع overwriteExisting: false
          </p>
        </div>

        <div className="p-3.5 rounded-xl bg-[#FAF8F5] border border-black/10">
          <p className="text-[11px] text-[#5A5E6B]">مستندات جديدة للكتابة</p>
          <p className="text-xl font-bold text-[#17523E] mt-1">
            {isOwnerVerified && preInspection
              ? `${preInspection.toWriteCount} مستنداً`
              : '—'}
          </p>
          <p className="text-[11px] text-[#5A5E6B] mt-0.5">
            عبر WriteBatch مباشر
          </p>
        </div>
      </div>

      {/* Explicit Scope Confirmation + Manual Trigger Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pt-1">
        <div className="text-xs text-[#5A5E6B] space-y-1 leading-relaxed">
          <p>
            • لا يبدأ الترحيل تلقائياً بعد تسجيل الدخول؛ يتم فقط عند ضغطك على
            زر التنفيذ يدوياً.
          </p>
          <p>
            • مستبعد بالكامل: الطلبات، أرقام الهواتف، نقاط الولاء، أكواد الخصم،
            وأسرار الإدارة وتيليغرام.
          </p>
          <p
            className={`font-semibold ${
              canTriggerMigration
                ? 'text-[#17523E]'
                : plan.issues.some((i) => i.severity === 'error')
                  ? 'text-[#9E1C28]'
                  : 'text-[#6B1D2F]'
            }`}
          >
            {!isOwnerVerified
              ? '• حالة الزر: ظاهر ومقفل أماناً حتى تسجّل دخول Google أعلاه بحساب wwwomara6@gmail.com.'
              : inspectBusy
                ? '• حالة الزر: جاري الفحص المسبق للمستندات الموجودة في Firestore...'
                : !plan.readyForExecution
                  ? '• حالة الزر: متوقف بسبب ملاحظات التحقق أدناه.'
                  : preInspection === null
                    ? '• حالة الزر: اضغط «إعادة فحص المستندات» لإكمال الفحص المسبق وتفعيل التنفيذ.'
                    : '• حالة الزر: جاهز للتنفيذ اليدوي — تم التحقق من المالك وفحص قاعدة البيانات.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {isOwnerVerified && (
            <button
              type="button"
              onClick={runReadOnlyPreInspection}
              disabled={inspectBusy || migrateBusy}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-[#14213D] bg-[#F2EFE9] hover:bg-[#E5E0D5] disabled:opacity-50 rounded-lg cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${inspectBusy ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>إعادة فحص المستندات</span>
            </button>
          )}

          <button
            type="button"
            data-testid="firestore-migration-button"
            onClick={handleExecuteMigration}
            disabled={!canTriggerMigration}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs sm:text-sm font-bold text-white bg-[#6B1D2F] hover:bg-[#14213D] disabled:opacity-60 disabled:cursor-not-allowed rounded-lg cursor-pointer transition-colors shadow-sm"
          >
            <CloudUpload className="w-4 h-4 text-[#E8CFA0]" aria-hidden="true" />
            <span>
              {migrateBusy
                ? 'جاري تنفيذ الترحيل الآمن...'
                : 'تنفيذ الترحيل الآمن الآن (WriteBatch)'}
            </span>
          </button>
        </div>
      </div>

      {plan.issues.length > 0 && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-[#FDFBF7] border border-[#A67C37]/40 text-xs text-[#6B1D2F] space-y-1"
        >
          <p className="font-bold">ملاحظات فحص البيانات ({plan.issues.length}):</p>
          {plan.issues.slice(0, 5).map((issue, idx) => (
            <p key={`${issue.productId}-${issue.field}-${idx}`}>
              • [{issue.code}] {issue.field}: {issue.message}
            </p>
          ))}
        </div>
      )}

      {/* Skipped Existing Docs Preview List (if any detected before write) */}
      {preInspection && preInspection.existingDocsCount > 0 && (
        <div className="p-3.5 rounded-xl bg-[#FDFBF7] border border-[#A67C37]/30 text-xs text-[#5A5E6B] space-y-1.5">
          <p className="font-semibold text-[#14213D]">
            تم رصد {preInspection.existingDocsCount} مستنداً موجوداً في Firestore
            وسيتم تخطيها تلقائياً دون استبدالها:
          </p>
          <p dir="ltr" className="text-[11px] font-mono break-all">
            {preInspection.skippedExisting
              .slice(0, 8)
              .map((d) => `${d.path} (${d.matchStatus})`)
              .join('، ')}
            {preInspection.skippedExisting.length > 8
              ? ` ... (+${preInspection.skippedExisting.length - 8} مستند)`
              : ''}
          </p>
        </div>
      )}

      {migrationError && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-[#FDF2F2] border border-[#9E1C28]/25 text-xs text-[#9E1C28] flex items-center gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{migrationError}</span>
        </div>
      )}

      {/* Post-Execution & Live Verification Result */}
      {executionResult && postVerification && (
        <div
          role="status"
          className={`p-4 rounded-xl border text-xs space-y-2 ${
            postVerification.verified
              ? 'bg-[#F0F7F4] border-[#1E6B52]/30 text-[#17523E]'
              : 'bg-[#FDFBF7] border-[#A67C37]/40 text-[#6B1D2F]'
          }`}
        >
          <div className="flex items-center gap-2 font-bold text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>
              {postVerification.verified
                ? 'تم تنفيذ الترحيل والتحقق من مطابقة جميع البيانات بنجاح'
                : 'اكتمل التنفيذ مع وجود ملاحظات في المطابقة'}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 tabular-nums">
            <p>الحساب المنفّذ: {executionResult.executedByEmail}</p>
            <p>مستندات كُتبت: {executionResult.writtenCount}</p>
            <p>مستندات متخطاة: {executionResult.skippedExistingCount}</p>
            <p>دفعات WriteBatch: {executionResult.batchesCommitted}</p>
            <p>
              إصدار الميتا: {postVerification.metaVersion ?? 'غير متوفر'}
            </p>
            <p>
              المنتجات المحققة: {postVerification.productDocsVerified} /{' '}
              {plan.productDocs.length}
            </p>
            <p>تعارض الأسعار: {postVerification.priceMismatches}</p>
            <p>تعارض الصور: {postVerification.imageMismatches}</p>
          </div>
        </div>
      )}
    </div>
  );
}
