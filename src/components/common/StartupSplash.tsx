import { AlertCircle, RotateCw } from "lucide-react"
import { CliniqoLogoIcon } from "./index"

export interface StartupSplashProps {
  error?: string | null
  onRetry?: () => void
  onContinue?: () => void
}

export function StartupSplash({ error, onRetry, onContinue }: StartupSplashProps) {
  return (
    <div
      className="cliniqo-splash-screen min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 px-6"
      role="status"
      aria-live="polite"
      aria-label={error ? "Startup issue" : "Loading Cliniqo workspace"}
    >
      <div className="cliniqo-splash-card w-full max-w-sm flex flex-col items-center text-center">
        <div className="cliniqo-splash-logo mb-5 inline-flex items-center justify-center rounded-3xl p-2 bg-white/90 dark:bg-slate-900/90 shadow-lg ring-1 ring-teal-500/15">
          <CliniqoLogoIcon size={64} />
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          Cliniqo
        </h1>
        <p className="mt-1.5 text-sm font-medium text-slate-500 dark:text-slate-400">
          Clinic Management, Simplified.
        </p>

        {error ? (
          <div
            className="mt-6 w-full rounded-xl border border-rose-200 dark:border-rose-800/60 bg-white dark:bg-slate-900 p-4 text-left shadow-sm"
            role="alert"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle size={18} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Unable to start local workspace
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-400 break-words">
                  {error}
                </p>
              </div>
            </div>
            {(onRetry || onContinue) && (
              <div className="mt-3.5 flex items-center justify-end gap-2">
                {onContinue && (
                  <button
                    type="button"
                    onClick={onContinue}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    Sign in manually
                  </button>
                )}
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#068D94] text-white hover:bg-[#00747A] transition-colors cursor-pointer"
                  >
                    <RotateCw size={13} />
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-7 w-40" aria-hidden="true">
            <div className="h-1 w-full overflow-hidden rounded-full bg-teal-950/10 dark:bg-teal-100/10">
              <div className="cliniqo-splash-bar h-full w-1/2 rounded-full bg-[#068D94]" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default StartupSplash
