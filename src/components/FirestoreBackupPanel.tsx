import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Download,
  FileJson,
  History,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import {
  AUTHORIZED_ADMIN_EMAIL,
  signInAdminWithGoogle,
  subscribeAdminAuth,
} from '../lib/firebase';
import {
  executeCatalogBackupRestore,
  exportLiveCatalogBackupFromFirestore,
  listRecentBackupAudits,
  parseAndValidateBackupFile,
  previewBackupRestoreDiff,
  triggerJsonFileDownload,
  type BackupAuditRecord,
  type BackupExportResult,
  type BackupRestoreDiffPreview,
  type BackupRestoreResult,
  type RestoreMode,
  type ValidatedBackupFile,
} from '../lib/firestoreBackup';
import { formatArabicDateTime } from '../utils/commerce';

interface FirestoreBackupPanelProps {
  onBeforeSyncLocalBackup?: (restored: BackupRestoreResult) => Promise<boolean>;
  onRestoreCompleted?: (restored: BackupRestoreResult) => Promise<void>;
  onStatusBanner?: (msg: string, tone: 'success' | 'warning' | 'error') => void;
}

export function FirestoreBackupPanel({
  onBeforeSyncLocalBackup,
  onRestoreCompleted,
  onStatusBanner,
}: FirestoreBackupPanelProps) {
  const [authReady, setAuthReady] = useState(false);
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [isOwnerVerified, setIsOwnerVerified] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);

  const [exportBusy, setExportBusy] = useState(false);
  const [lastExport, setLastExport] = useState<BackupExportResult | null>(null);
  const [recentAudits, setRecentAudits] = useState<BackupAuditRecord[]>([]);
  const [auditsLoading, setAuditsLoading] = useState(false);

  const [selectedFileName, setSelectedFileName] = useState('');
  const [validateBusy, setValidateBusy] = useState(false);
  const [validatedBackup, setValidatedBackup] =
    useState<ValidatedBackupFile | null>(null);

  const [diffBusy, setDiffBusy] = useState(false);
  const [diffPreview, setDiffPreview] =
    useState<BackupRestoreDiffPreview | null>(null);

  const [restoreMode, setRestoreMode] = useState<RestoreMode>(
    'merge_preserve_live'
  );
  const [confirmExactMirror, setConfirmExactMirror] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreResult, setRestoreResult] =
    useState<BackupRestoreResult | null>(null);
  const [localMirrorWarning, setLocalMirrorWarning] = useState('');

  const [panelError, setPanelError] = useState('');

  useEffect(() => {
    const unsubscribe = subscribeAdminAuth(({ ready, user, isAdmin }) => {
      setAuthReady(ready);
      setGoogleUser(user);
      setIsOwnerVerified(isAdmin);
      if (!isAdmin) {
        setDiffPreview(null);
        setRecentAudits([]);
      }
    });
    return () => unsubscribe();
  }, []);

  const refreshAuditHistory = useCallback(
    async (user: User | null = googleUser) => {
      if (!isOwnerVerified || !user) return;
      setAuditsLoading(true);
      try {
        const records = await listRecentBackupAudits({ user, limitCount: 5 });
        setRecentAudits(records);
      } finally {
        setAuditsLoading(false);
      }
    },
    [googleUser, isOwnerVerified]
  );

  useEffect(() => {
    if (isOwnerVerified && googleUser) {
      void refreshAuditHistory(googleUser);
    }
  }, [isOwnerVerified, googleUser, refreshAuditHistory]);

  const runReadOnlyDiffPreview = useCallback(
    async (fileCheck: ValidatedBackupFile, ownerUser: User) => {
      if (!fileCheck.valid) return;
      setDiffBusy(true);
      setPanelError('');
      try {
        const preview = await previewBackupRestoreDiff(fileCheck, {
          user: ownerUser,
        });
        setDiffPreview(preview);
      } catch (err) {
        setDiffPreview(null);
        setPanelError(
          err instanceof Error
            ? err.message
            : 'تعذر إجراء معاينة الفروقات مقابل Firestore الحي.'
        );
      } finally {
        setDiffBusy(false);
      }
    },
    []
  );

  useEffect(() => {
    if (
      isOwnerVerified &&
      googleUser &&
      validatedBackup?.valid &&
      !diffPreview &&
      !diffBusy
    ) {
      void runReadOnlyDiffPreview(validatedBackup, googleUser);
    }
  }, [
    isOwnerVerified,
    googleUser,
    validatedBackup,
    diffPreview,
    diffBusy,
    runReadOnlyDiffPreview,
  ]);

  const handleGoogleLogin = async () => {
    setAuthBusy(true);
    setPanelError('');
    try {
      await signInAdminWithGoogle();
    } catch (err) {
      setPanelError(
        err instanceof Error
          ? err.message
          : 'تعذر تسجيل الدخول بحساب Google الموثق.'
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const handleExportBackup = async () => {
    if (!isOwnerVerified || !googleUser) return;
    setExportBusy(true);
    setPanelError('');
    try {
      const result = await exportLiveCatalogBackupFromFirestore({
        user: googleUser,
        recordAuditLog: true,
      });
      triggerJsonFileDownload(result.backup, result.filename);
      setLastExport(result);
      await refreshAuditHistory(googleUser);

      if (result.auditWarning || result.countMismatchWarning) {
        onStatusBanner?.(
          result.auditWarning ?? result.countMismatchWarning ?? '',
          'warning'
        );
      } else {
        onStatusBanner?.(
          `تم تصدير وتنزيل نسخة احتياطية كاملة (${result.backup.counts.productsCount} منتجاً) بنجاح.`,
          'success'
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'تعذر تصدير النسخة الاحتياطية من Firestore.';
      setPanelError(msg);
      onStatusBanner?.(msg, 'error');
    } finally {
      setExportBusy(false);
    }
  };

  const handleBackupFileSelected = async (
    e: ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFileName(file.name);
    setValidateBusy(true);
    setPanelError('');
    setValidatedBackup(null);
    setDiffPreview(null);
    setRestoreResult(null);
    setLocalMirrorWarning('');
    setRestoreMode('merge_preserve_live');
    setConfirmExactMirror(false);

    try {
      const text = await file.text();
      const validation = await parseAndValidateBackupFile(text);
      setValidatedBackup(validation);

      if (validation.valid && isOwnerVerified && googleUser) {
        await runReadOnlyDiffPreview(validation, googleUser);
      }
    } catch (err) {
      setPanelError(
        err instanceof Error
          ? err.message
          : 'تعذر قراءة أو فحص ملف النسخة الاحتياطية.'
      );
    } finally {
      setValidateBusy(false);
    }
  };

  const handleExecuteRestore = async () => {
    if (!isOwnerVerified || !googleUser || !validatedBackup?.valid || !diffPreview) {
      return;
    }
    if (restoreMode === 'exact_mirror' && !confirmExactMirror) {
      return;
    }

    setRestoreBusy(true);
    setPanelError('');
    setLocalMirrorWarning('');
    try {
      const result = await executeCatalogBackupRestore(validatedBackup, {
        user: googleUser,
        mode: restoreMode,
        confirmExactMirror:
          restoreMode === 'exact_mirror' ? confirmExactMirror : false,
        expectedDeleteCount: diffPreview.liveOnlyProducts.length,
      });

      setRestoreResult(result);
      setConfirmExactMirror(false);

      let mirrorFailed = false;
      if (onBeforeSyncLocalBackup) {
        try {
          const ok = await onBeforeSyncLocalBackup(result);
          if (!ok) mirrorFailed = true;
        } catch {
          mirrorFailed = true;
        }
      }

      if (onRestoreCompleted) {
        await onRestoreCompleted(result);
      }

      await runReadOnlyDiffPreview(validatedBackup, googleUser);

      if (mirrorFailed) {
        const warnText =
          'تمت الاستعادة في Firestore وظهرت التغييرات للزوار بنجاح، لكن تعذر مزامنة النسخة الاحتياطية المحلية على الخادم.';
        setLocalMirrorWarning(warnText);
        onStatusBanner?.(warnText, 'warning');
      } else {
        onStatusBanner?.(
          `تمت استعادة ${result.restoredProductCount} منتجاً إلى Firestore بنجاح (وضع: ${
            result.mode === 'merge_preserve_live'
              ? 'الدمج الآمن'
              : 'المطابقة الحرفية'
          }).`,
          'success'
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'تعذر تنفيذ الاستعادة إلى Firestore. لم تتضرر البيانات الحية.';
      setPanelError(msg);
      onStatusBanner?.(msg, 'error');
    } finally {
      setRestoreBusy(false);
    }
  };

  const canRestore =
    isOwnerVerified &&
    Boolean(googleUser) &&
    Boolean(validatedBackup?.valid) &&
    diffPreview !== null &&
    !diffBusy &&
    !restoreBusy &&
    !exportBusy &&
    (restoreMode === 'merge_preserve_live' || confirmExactMirror);

  return (
    <div
      id="firestore-backup-panel"
      data-testid="firestore-backup-panel"
      className="bg-white rounded-2xl border border-black/10 p-6 space-y-6"
    >
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-black/10">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#6B1D2F] text-[#E8CFA0] flex items-center justify-center shrink-0">
            <Archive className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-[#14213D]">
              النسخ الاحتياطي والاستعادة السحابية (JSON + SHA-256)
            </h2>
            <p className="text-xs text-[#5A5E6B] mt-1 leading-relaxed">
              تصدير نسخة كاملة ومحدثة من Firestore الحقيقي إلى جهازك (بـ 3 قراءات
              فقط لـ 229 منتجاً)، واستعادة النسخ مع التحقق الرقمي ومعاينة الفروقات
              قبل أي كتابة، مع الإبقاء على الدمج الآمن كخيار افتراضي.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {!authReady ? (
            <span className="text-xs text-[#5A5E6B]">جاري فحص جلسة Google...</span>
          ) : isOwnerVerified && googleUser ? (
            <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#F0F7F4] border border-[#1E6B52]/25 text-xs text-[#17523E]">
              <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>جاهز: </span>
              <span dir="ltr" className="font-semibold">
                {googleUser.email}
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={authBusy}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#14213D] hover:bg-[#6B1D2F] disabled:opacity-50 rounded-lg cursor-pointer transition-colors"
            >
              <ShieldCheck className="w-4 h-4 text-[#E8CFA0]" aria-hidden="true" />
              <span>
                {authBusy
                  ? 'جاري تسجيل الدخول...'
                  : `تسجيل دخول المالك (${AUTHORIZED_ADMIN_EMAIL})`}
              </span>
            </button>
          )}
        </div>
      </div>

      {panelError && (
        <div
          role="alert"
          data-testid="backup-panel-error"
          className="p-3.5 rounded-xl bg-[#FDF2F2] border border-[#9E1C28]/25 text-xs text-[#9E1C28] flex items-center gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{panelError}</span>
        </div>
      )}

      {/* Split Grid: Export Live Catalog | Validate & Restore JSON */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Column 1: Export Live Firestore -> JSON Download + Audit History */}
        <div className="rounded-xl border border-black/10 bg-[#FAF8F5] p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-display text-base font-bold text-[#14213D] flex items-center gap-2">
                <Download className="w-4 h-4 text-[#6B1D2F]" aria-hidden="true" />
                <span>1. تصدير نسخة احتياطية كاملة من Firestore</span>
              </h3>
              <p className="text-xs text-[#5A5E6B] mt-1 leading-relaxed">
                يشمل جميع المنتجات وأسعارها وأحجامها وصورها والنوتات وبيانات المتجر
                وروابط التواصل مع بصمة SHA-256، ويُنزّل الملف مباشرة لجهازك.
              </p>
            </div>
          </div>

          <button
            type="button"
            data-testid="firestore-export-backup-button"
            onClick={handleExportBackup}
            disabled={!isOwnerVerified || exportBusy || restoreBusy}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-xs sm:text-sm font-bold text-white bg-[#14213D] hover:bg-[#6B1D2F] disabled:opacity-55 disabled:cursor-not-allowed rounded-lg cursor-pointer transition-colors"
          >
            <Download className="w-4 h-4 text-[#E8CFA0]" aria-hidden="true" />
            <span>
              {exportBusy
                ? 'جاري قراءة الكتالوج وتنزيل JSON...'
                : 'تصدير وتنزيل نسخة احتياطية كاملة (JSON)'}
            </span>
          </button>

          {!isOwnerVerified && (
            <p className="text-[11px] text-[#6B1D2F]">
              • مقفل أماناً: يرجى تسجيل دخول Google للمالك أولاً لتفعيل التصدير من
              Firestore.
            </p>
          )}

          {lastExport && (
            <div
              role="status"
              data-testid="backup-export-summary"
              className="p-3.5 rounded-lg bg-[#F0F7F4] border border-[#1E6B52]/25 text-xs text-[#17523E] space-y-1.5"
            >
              <p className="font-bold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>تم تجهيز وتنزيل النسخة الاحتياطية بنجاح</span>
              </p>
              <p dir="ltr" className="font-mono text-[11px] break-all">
                {lastExport.filename}
              </p>
              <div className="grid grid-cols-2 gap-1.5 text-[11px] tabular-nums">
                <span>المنتجات: {lastExport.backup.counts.productsCount}</span>
                <span>القراءات المستهلكة: {lastExport.readsUsed}</span>
                <span>الإصدار: {lastExport.backup.source.catalogVersion}</span>
                <span dir="ltr" className="truncate font-mono">
                  SHA-256: {lastExport.backup.checksumSha256.slice(0, 14)}...
                </span>
              </div>
              {lastExport.auditWarning && (
                <p className="text-[11px] text-[#7A5218] pt-1">
                  {lastExport.auditWarning}
                </p>
              )}
            </div>
          )}

          {/* Recent Audit History from Firestore backups/ collection */}
          <div className="pt-2 border-t border-black/10 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-[#14213D] flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-[#6B1D2F]" aria-hidden="true" />
                <span>سجل البصمات السحابي (backups)</span>
              </span>
              {isOwnerVerified && (
                <button
                  type="button"
                  onClick={() => void refreshAuditHistory()}
                  disabled={auditsLoading}
                  className="text-[11px] text-[#6B1D2F] hover:underline cursor-pointer disabled:opacity-50"
                >
                  {auditsLoading ? 'تحديث...' : 'تحديث السجل'}
                </button>
              )}
            </div>

            {!isOwnerVerified ? (
              <p className="text-[11px] text-[#5A5E6B]">
                يظهر سجل تصدير النسخ السابقة بعد تسجيل دخول المالك.
              </p>
            ) : recentAudits.length === 0 ? (
              <p className="text-[11px] text-[#5A5E6B]">
                لا توجد عمليات تصدير مسجلة في مجموعة backups بعد.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {recentAudits.map((rec) => (
                  <div
                    key={rec.id}
                    className="p-2 rounded-lg bg-white border border-black/10 text-[11px] flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-[#14213D] truncate">
                        {rec.productCount} منتجاً — {formatArabicDateTime(rec.createdAt)}
                      </p>
                      <p dir="ltr" className="font-mono text-[10px] text-[#5A5E6B] truncate">
                        SHA-256: {rec.checksumSha256.slice(0, 18)}...
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Column 2: Upload, Validate, Diff Preview & Safe Restore */}
        <div className="rounded-xl border border-black/10 bg-[#FAF8F5] p-5 space-y-4">
          <div>
            <h3 className="font-display text-base font-bold text-[#14213D] flex items-center gap-2">
              <Upload className="w-4 h-4 text-[#6B1D2F]" aria-hidden="true" />
              <span>2. فحص واستعادة نسخة JSON</span>
            </h3>
            <p className="text-xs text-[#5A5E6B] mt-1 leading-relaxed">
              يُفحص الملف محلياً بالكامل أولاً، ثم تُعرض الفروقات الحية مقارنةً
              بقاعدة Firestore دون لمس أي منتج قبل تأكيدك النهائي.
            </p>
          </div>

          <label className="block">
            <span className="sr-only">اختيار ملف النسخة الاحتياطية JSON</span>
            <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-dashed border-[#14213D]/30 bg-white hover:border-[#6B1D2F] cursor-pointer transition-colors">
              <div className="flex items-center gap-2.5 min-w-0">
                <FileJson className="w-5 h-5 text-[#6B1D2F] shrink-0" aria-hidden="true" />
                <span className="text-xs font-semibold text-[#14213D] truncate">
                  {validateBusy
                    ? 'جاري فحص الملف والتحقق الرقمي...'
                    : selectedFileName || 'اضغط لاختيار ملف نسخة احتياطية (.json)'}
                </span>
              </div>
              <span className="px-2.5 py-1 rounded bg-[#F2EFE9] text-[11px] font-semibold text-[#14213D] shrink-0">
                استعراض
              </span>
            </div>
            <input
              type="file"
              accept=".json,application/json"
              data-testid="firestore-backup-file-input"
              onChange={(e) => {
                void handleBackupFileSelected(e);
              }}
              className="sr-only"
            />
          </label>

          {/* Local Validation Result */}
          {validatedBackup && !validatedBackup.valid && (
            <div
              role="alert"
              data-testid="backup-validation-error"
              className="p-3.5 rounded-lg bg-[#FDF2F2] border border-[#9E1C28]/25 text-xs text-[#9E1C28] space-y-1"
            >
              <p className="font-bold">فشل التحقق الصارم من الملف (ممنوع الاستعادة):</p>
              {validatedBackup.errors.map((errMsg, idx) => (
                <p key={idx}>• {errMsg}</p>
              ))}
            </div>
          )}

          {validatedBackup && validatedBackup.valid && (
            <div
              role="status"
              data-testid="backup-validation-success"
              className="p-3.5 rounded-lg bg-[#F0F7F4] border border-[#1E6B52]/25 text-xs text-[#17523E] space-y-1.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>ملف صالح ومطابق لقواعد Firestore</span>
                </span>
                <span className="text-[11px] font-semibold">
                  {validatedBackup.checksumVerified
                    ? 'SHA-256 موثّق'
                    : 'صيغة قديمة مفحوصة'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-[11px] tabular-nums">
                <span>عدد المنتجات: {validatedBackup.products.length}</span>
                <span>روابط التواصل: {validatedBackup.socialLinks.length}</span>
                {validatedBackup.exportedAt && (
                  <span className="col-span-2">
                    تاريخ التصدير: {formatArabicDateTime(validatedBackup.exportedAt)}
                  </span>
                )}
              </div>
              {validatedBackup.warnings.map((warn, idx) => (
                <p key={idx} className="text-[11px] text-[#7A5218]">
                  • {warn}
                </p>
              ))}
            </div>
          )}

          {/* Read-Only Diff Preview */}
          {validatedBackup?.valid && isOwnerVerified && (
            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#14213D]">
                  معاينة الفروقات مقابل Firestore الحي (قراءة فقط)
                </span>
                <button
                  type="button"
                  data-testid="firestore-diff-preview-button"
                  onClick={() =>
                    googleUser &&
                    void runReadOnlyDiffPreview(validatedBackup, googleUser)
                  }
                  disabled={diffBusy || restoreBusy}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6B1D2F] hover:underline cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw
                    className={`w-3 h-3 ${diffBusy ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  <span>{diffBusy ? 'جاري الفحص...' : 'إعادة المعاينة'}</span>
                </button>
              </div>

              {diffPreview && (
                <>
                  <div
                    data-testid="backup-diff-summary"
                    className="grid grid-cols-2 sm:grid-cols-4 gap-2 tabular-nums"
                  >
                    <div className="p-2.5 rounded-lg bg-white border border-black/10">
                      <p className="text-[10px] text-[#5A5E6B]">ستُضاف</p>
                      <p className="text-base font-bold text-[#17523E]">
                        {diffPreview.toAdd.length}
                      </p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-white border border-black/10">
                      <p className="text-[10px] text-[#5A5E6B]">ستُحدَّث</p>
                      <p className="text-base font-bold text-[#14213D]">
                        {diffPreview.toUpdate.length}
                      </p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-white border border-black/10">
                      <p className="text-[10px] text-[#5A5E6B]">متطابقة تُتخطى</p>
                      <p className="text-base font-bold text-[#5A5E6B]">
                        {diffPreview.unchangedCount}
                      </p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-white border border-black/10">
                      <p className="text-[10px] text-[#5A5E6B]">موجودة حياً فقط</p>
                      <p className="text-base font-bold text-[#6B1D2F]">
                        {diffPreview.liveOnlyProducts.length}
                      </p>
                    </div>
                  </div>

                  <div className="text-[11px] text-[#5A5E6B] space-y-1">
                    <p>
                      • بيانات المتجر:{' '}
                      {diffPreview.storeInfoChanged ? 'ستُحدَّث' : 'متطابقة'} ·
                      روابط التواصل:{' '}
                      {diffPreview.socialLinksChanged ? 'ستُحدَّث' : 'متطابقة'}
                      {diffPreview.matchedAuditRecord
                        ? ' · البصمة مسجلة في سجل backups السحابي'
                        : ''}
                    </p>
                    {diffPreview.liveOnlyProducts.length > 0 && (
                      <p className="text-[#6B1D2F]">
                        • منتجات مضافة حياً بعد هذه النسخة:{' '}
                        {diffPreview.liveOnlyProducts
                          .slice(0, 4)
                          .map((p) => `${p.code} (${p.name})`)
                          .join('، ')}
                        {diffPreview.liveOnlyProducts.length > 4
                          ? ` ... (+${diffPreview.liveOnlyProducts.length - 4})`
                          : ''}
                      </p>
                    )}
                  </div>

                  {/* Restore Mode Selection */}
                  <div className="space-y-2 pt-1">
                    <p className="text-xs font-bold text-[#14213D]">
                      وضع الاستعادة:
                    </p>

                    <label className="flex items-start gap-2.5 p-3 rounded-lg bg-white border border-black/15 cursor-pointer">
                      <input
                        type="radio"
                        name="firestore-restore-mode"
                        value="merge_preserve_live"
                        data-testid="restore-mode-merge"
                        checked={restoreMode === 'merge_preserve_live'}
                        onChange={() => {
                          setRestoreMode('merge_preserve_live');
                          setConfirmExactMirror(false);
                        }}
                        className="mt-0.5 accent-[#17523E]"
                      />
                      <div className="text-xs">
                        <p className="font-bold text-[#14213D]">
                          الدمج الآمن دون حذف المنتجات الإضافية (الافتراضي)
                        </p>
                        <p className="text-[11px] text-[#5A5E6B] mt-0.5">
                          يستعيد ويعيد تحديث {diffPreview.toAdd.length + diffPreview.toUpdate.length}{' '}
                          منتجاً من النسخة ويحافظ على جميع المنتجات المضافة حياً ({diffPreview.liveOnlyProducts.length}).
                        </p>
                      </div>
                    </label>

                    <label className="flex items-start gap-2.5 p-3 rounded-lg bg-white border border-[#9E1C28]/25 cursor-pointer">
                      <input
                        type="radio"
                        name="firestore-restore-mode"
                        value="exact_mirror"
                        data-testid="restore-mode-exact-mirror"
                        checked={restoreMode === 'exact_mirror'}
                        onChange={() => {
                          setRestoreMode('exact_mirror');
                          setConfirmExactMirror(false);
                        }}
                        className="mt-0.5 accent-[#9E1C28]"
                      />
                      <div className="text-xs">
                        <p className="font-bold text-[#9E1C28] flex items-center gap-1">
                          <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>
                            المطابقة الحرفية للنسخة (متقدم — معطل افتراضياً)
                          </span>
                        </p>
                        <p className="text-[11px] text-[#5A5E6B] mt-0.5">
                          يعيد الكتالوج مطابقاً تماماً للملف المرفوع (سيحذف{' '}
                          {diffPreview.liveOnlyProducts.length} منتجاً مضافاً بعد
                          النسخة).
                        </p>
                      </div>
                    </label>

                    {restoreMode === 'exact_mirror' && (
                      <label className="flex items-start gap-2.5 p-3 rounded-lg bg-[#FDF2F2] border border-[#9E1C28]/35 text-xs text-[#9E1C28] cursor-pointer">
                        <input
                          type="checkbox"
                          data-testid="exact-mirror-confirm-checkbox"
                          checked={confirmExactMirror}
                          onChange={(e) => setConfirmExactMirror(e.target.checked)}
                          className="mt-0.5 accent-[#9E1C28]"
                        />
                        <span className="font-semibold leading-relaxed">
                          أقرّ صراحةً بفهمي أن وضع المطابقة الحرفية سيقوم بحذف{' '}
                          {diffPreview.liveOnlyProducts.length} منتجاً وتحديث{' '}
                          {diffPreview.toUpdate.length} منتجاً وإضافة{' '}
                          {diffPreview.toAdd.length} منتجاً ليصبح الإجمالي{' '}
                          {diffPreview.exactMirrorPlanSummary.resultProductCount} منتجاً.
                        </span>
                      </label>
                    )}
                  </div>

                  {/* Pre-Restore Safety Export + Restore Trigger */}
                  <div className="flex flex-col sm:flex-row gap-2.5 pt-2">
                    <button
                      type="button"
                      onClick={handleExportBackup}
                      disabled={exportBusy || restoreBusy}
                      className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-[#14213D] bg-white border border-black/15 hover:bg-[#F2EFE9] disabled:opacity-50 rounded-lg cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>تنزيل نسخة أمان أولاً</span>
                    </button>

                    <button
                      type="button"
                      data-testid="firestore-restore-button"
                      onClick={handleExecuteRestore}
                      disabled={!canRestore}
                      className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-bold text-white bg-[#6B1D2F] hover:bg-[#14213D] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg cursor-pointer transition-colors"
                    >
                      <RotateCcw className="w-4 h-4 text-[#E8CFA0]" aria-hidden="true" />
                      <span>
                        {restoreBusy
                          ? 'جاري تنفيذ الاستعادة...'
                          : 'تنفيذ الاستعادة الآمنة الآن (WriteBatch)'}
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {restoreResult && (
            <div
              role="status"
              data-testid="backup-restore-result"
              className="p-3.5 rounded-lg bg-[#F0F7F4] border border-[#1E6B52]/30 text-xs text-[#17523E] space-y-1.5"
            >
              <p className="font-bold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>اكتملت الاستعادة إلى Firestore بنجاح</span>
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-[11px] tabular-nums">
                <span>الإجمالي: {restoreResult.restoredProductCount}</span>
                <span>أُضيف: {restoreResult.addedCount}</span>
                <span>حُدِّث: {restoreResult.updatedCount}</span>
                <span>حُذف: {restoreResult.deletedCount}</span>
                <span>حُفظت حياً: {restoreResult.preservedLiveOnlyCount}</span>
                <span>دفعات: {restoreResult.batchesCommitted}</span>
              </div>
              {localMirrorWarning && (
                <p className="text-[11px] text-[#7A5218] pt-1">
                  {localMirrorWarning}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
