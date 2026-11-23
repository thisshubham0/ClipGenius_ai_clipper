import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';
import { apiFetch, setAuthTokenProvider } from '../lib/apiClient';
import { signInWithGooglePopup } from '../lib/firebase';
import { formatGoogleAuthError, validateAuthForm } from '../lib/validation';
import type { BrandKit, User } from '../types/clipgenius';

export type AuthScreenMode = 'signin' | 'signup';

interface AuthViewProps {
  initialMode?: AuthScreenMode;
  onBackToLanding: () => void;
  onAuthenticated: (
    user: User,
    options?: {
      isAuthenticatedAccount?: boolean;
      authMethod?: 'none' | 'google' | 'email';
      brandKit?: BrandKit | null;
      exportsCompleted?: number;
      notice?: string;
    }
  ) => void;
}

export function AuthView({
  initialMode = 'signin',
  onBackToLanding,
  onAuthenticated,
}: AuthViewProps) {
  const [mode, setMode] = useState<AuthScreenMode>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [submittingAction, setSubmittingAction] = useState<'email' | 'google' | null>(null);

  useEffect(() => {
    setMode(initialMode);
    setError(null);
    setErrorCode(null);
    setInfoMessage(null);
  }, [initialMode]);

  const isBusy = submittingAction !== null;

  function switchMode(nextMode: AuthScreenMode) {
    setMode(nextMode);
    setError(null);
    setErrorCode(null);
    setInfoMessage(null);
    setPassword('');
    setConfirmPassword('');
  }

  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    if (isBusy) return;

    setError(null);
    setErrorCode(null);
    setInfoMessage(null);

    const validation = validateAuthForm(mode, {
      email,
      password,
      name: mode === 'signup' ? name : undefined,
    });
    if (!validation.valid) {
      setError(validation.error ?? 'Please check your account details.');
      return;
    }

    if (mode === 'signup' && password !== confirmPassword) {
      setError('Passwords do not match. Please confirm your password.');
      return;
    }

    setSubmittingAction('email');
    try {
      const endpoint = mode === 'signup' ? '/api/auth/register' : '/api/auth/login';
      const payload =
        mode === 'signup'
          ? {
              name: name.trim(),
              email: email.trim().toLowerCase(),
              password,
              confirmPassword,
            }
          : {
              email: email.trim().toLowerCase(),
              password,
            };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        token?: string;
        user?: User;
        brandKit?: BrandKit | null;
        exportsCompleted?: number;
        error?: string;
        code?: string;
      };

      if (!res.ok || !data.token || !data.user) {
        setErrorCode(data.code ?? null);
        setError(
          data.error ||
            (mode === 'signup'
              ? 'Unable to create your account right now.'
              : 'Unable to sign in. Check your email and password.')
        );
        return;
      }

      const sessionToken = data.token;
      setAuthTokenProvider(async () => sessionToken, sessionToken);

      onAuthenticated(data.user, {
        isAuthenticatedAccount: true,
        authMethod: 'email',
        brandKit: data.brandKit ?? null,
        exportsCompleted: data.exportsCompleted,
        notice:
          mode === 'signup'
            ? `Account created for ${data.user.email}. Your projects, clips, and Brand Kit sync automatically.`
            : `Signed in as ${data.user.email}. Welcome back to ClipGenius.`,
      });
    } catch {
      setError('Network error while connecting to ClipGenius. Please try again.');
    } finally {
      setSubmittingAction(null);
    }
  }

  async function handleGoogleSignIn() {
    if (isBusy) return;
    setError(null);
    setErrorCode(null);
    setInfoMessage(null);
    setSubmittingAction('google');

    try {
      const { firebaseUser, idToken } = await signInWithGooglePopup();
      setAuthTokenProvider(() => firebaseUser.getIdToken(), idToken);

      const meRes = await apiFetch('/api/me');
      if (!meRes.ok) {
        const errData = (await meRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(errData.error || 'Unable to verify your ClipGenius account.');
      }

      const data = (await meRes.json()) as {
        user?: User;
        brandKit?: BrandKit | null;
        exportsCompleted?: number;
      };

      const syncedUser: User = data.user ?? {
        id: firebaseUser.uid,
        email: firebaseUser.email ?? 'creator@clipgenius.app',
        name: firebaseUser.displayName ?? 'ClipGenius Creator',
        plan: 'creator',
        role: 'creator',
        createdAt: new Date().toISOString(),
      };

      onAuthenticated(syncedUser, {
        isAuthenticatedAccount: true,
        authMethod: 'google',
        brandKit: data.brandKit ?? null,
        exportsCompleted: data.exportsCompleted,
        notice: `Signed in as ${syncedUser.email}. Your projects, clips, and Brand Kit sync automatically.`,
      });
    } catch (err) {
      const formatted = formatGoogleAuthError(err);
      if (formatted.kind === 'info') {
        setInfoMessage(formatted.message);
      } else {
        setError(formatted.message);
      }
    } finally {
      setSubmittingAction(null);
    }
  }

  function handleEnterSampleWorkspace() {
    onAuthenticated(
      {
        id: 'demo_user',
        email: 'demo@clipgenius.local',
        name: 'Studio Preview',
        plan: 'creator',
        role: 'creator',
        createdAt: new Date().toISOString(),
      },
      {
        isAuthenticatedAccount: false,
        authMethod: 'none',
        notice:
          'Entered Sample Workspace preview. Sign in or create an account anytime to save projects and Brand Kit across sessions.',
      }
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0D11] text-[#F3F4F6] flex flex-col justify-center px-6 py-6">
      <div className="mx-auto w-full max-w-[460px]">
        <button
          type="button"
          onClick={onBackToLanding}
          className="inline-flex items-center gap-2 text-xs font-medium text-slate-400 hover:text-white mb-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to ClipGenius home
        </button>

        <div className="rounded-xl border border-white/10 bg-[#131720] p-6 sm:p-7 space-y-5">
          {/* Mode Tabs: Sign In vs Create Account */}
          <div
            role="tablist"
            aria-label="Account authentication mode"
            className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-[#0B0D11] p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signin'}
              disabled={isBusy}
              onClick={() => switchMode('signin')}
              className={`rounded-md px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                mode === 'signin'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signup'}
              disabled={isBusy}
              onClick={() => switchMode('signup')}
              className={`rounded-md px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                mode === 'signup'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Create Account
            </button>
          </div>

          <div>
            <h1 className="font-display text-2xl font-semibold text-white">
              {mode === 'signin' ? 'Sign in to ClipGenius' : 'Create your ClipGenius account'}
            </h1>
            <p className="mt-1.5 text-sm text-slate-400">
              {mode === 'signin'
                ? 'Already have an account? Enter your email and password to access your projects and Brand Kit.'
                : 'Sign up with your email and set a password to save projects, ranked clips, and exports.'}
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200 space-y-2"
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{error}</span>
              </div>
              {errorCode === 'ACCOUNT_EXISTS' && mode === 'signup' && (
                <button
                  type="button"
                  onClick={() => switchMode('signin')}
                  className="ml-6 inline-flex items-center font-semibold text-amber-300 hover:text-amber-200 underline underline-offset-2"
                >
                  Switch to Sign In with this email
                </button>
              )}
            </div>
          )}

          {infoMessage && (
            <div
              role="status"
              className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100"
            >
              <CheckCircle2
                className="h-4 w-4 text-amber-400 shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <span>{infoMessage}</span>
            </div>
          )}

          {/* Email + Password Form */}
          <form onSubmit={(e) => void handleEmailSubmit(e)} className="space-y-3.5" noValidate>
            {mode === 'signup' && (
              <div>
                <label htmlFor="auth-name" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Full name
                </label>
                <div className="relative">
                  <UserIcon
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500"
                    aria-hidden="true"
                  />
                  <input
                    id="auth-name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    required
                    disabled={isBusy}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Jordan Rivera"
                    className="w-full rounded-lg border border-white/15 bg-[#0B0D11] pl-9 pr-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
                  />
                </div>
              </div>
            )}

            <div>
              <label htmlFor="auth-email" className="block text-xs font-medium text-slate-300 mb-1.5">
                Email address
              </label>
              <div className="relative">
                <Mail
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500"
                  aria-hidden="true"
                />
                <input
                  id="auth-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  disabled={isBusy}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@studio.com"
                  className="w-full rounded-lg border border-white/15 bg-[#0B0D11] pl-9 pr-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="auth-password" className="block text-xs font-medium text-slate-300">
                  {mode === 'signup' ? 'Set password' : 'Password'}
                </label>
                {mode === 'signup' && (
                  <span className="text-[11px] text-slate-400">Min. 8 characters</span>
                )}
              </div>
              <div className="relative">
                <Lock
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500"
                  aria-hidden="true"
                />
                <input
                  id="auth-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  required
                  minLength={8}
                  disabled={isBusy}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'signup' ? 'Create a strong password' : 'Enter your password'}
                  className="w-full rounded-lg border border-white/15 bg-[#0B0D11] pl-9 pr-10 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            {mode === 'signup' && (
              <div>
                <label
                  htmlFor="auth-confirm-password"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Confirm password
                </label>
                <div className="relative">
                  <Lock
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500"
                    aria-hidden="true"
                  />
                  <input
                    id="auth-confirm-password"
                    name="confirmPassword"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    minLength={8}
                    disabled={isBusy}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter your password"
                    className="w-full rounded-lg border border-white/15 bg-[#0B0D11] pl-9 pr-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={isBusy}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
            >
              {submittingAction === 'email' && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {submittingAction === 'email'
                ? mode === 'signup'
                  ? 'Creating Account...'
                  : 'Signing In...'
                : mode === 'signup'
                ? 'Create Account & Set Password'
                : 'Sign In'}
            </button>
          </form>

          {/* Direct mode switch prompt */}
          <div className="text-center text-xs text-slate-400">
            {mode === 'signup' ? (
              <>
                Already have an account?{' '}
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => switchMode('signin')}
                  className="font-semibold text-amber-400 hover:text-amber-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
                >
                  Sign in
                </button>
              </>
            ) : (
              <>
                Don&apos;t have an account yet?{' '}
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => switchMode('signup')}
                  className="font-semibold text-amber-400 hover:text-amber-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
                >
                  Create an account &amp; set password
                </button>
              </>
            )}
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="h-px flex-1 bg-white/10" />
            <span>or</span>
            <span className="h-px flex-1 bg-white/10" />
          </div>

          <div className="space-y-2.5">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleGoogleSignIn()}
              className="w-full inline-flex items-center justify-center gap-2.5 rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10 disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              {submittingAction === 'google' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M21.35 11.1H12v2.98h5.35c-.23 1.5-1.74 4.4-5.35 4.4-3.22 0-5.85-2.67-5.85-5.98s2.63-5.98 5.85-5.98c1.83 0 3.06.78 3.76 1.45l2.56-2.48C16.68 3.96 14.55 3 12 3 7.03 3 3 7.03 3 12s4.03 9 9 9c5.2 0 8.64-3.65 8.64-8.8 0-.59-.06-1.04-.29-1.1z"
                  />
                </svg>
              )}
              {submittingAction === 'google' ? 'Connecting Google Account...' : 'Continue with Google'}
            </button>

            <button
              type="button"
              disabled={isBusy}
              onClick={handleEnterSampleWorkspace}
              className="w-full rounded-lg border border-white/10 bg-[#0B0D11] px-4 py-2.5 text-xs font-medium text-slate-300 hover:bg-white/5 hover:text-white transition-colors"
            >
              Enter Sample Workspace Directly
            </button>
          </div>

          <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-3.5 flex items-start gap-2.5 text-xs text-slate-400">
            <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              Passwords are salted and hashed server-side, and session tokens stay in memory only.
              Each workspace is isolated to its account owner.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
