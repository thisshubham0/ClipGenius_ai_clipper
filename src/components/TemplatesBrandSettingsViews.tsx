import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Loader2,
  LogIn,
  LogOut,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { CAPTION_STYLES } from '../data/demoProject';
import type {
  AspectRatio,
  BrandKit,
  CaptionStylePreset,
  SystemConfigStatus,
  User,
} from '../types/clipgenius';

interface TemplatesViewProps {
  onApplyTemplate: (preset: CaptionStylePreset, ratio: AspectRatio) => void;
}

const STUDIO_TEMPLATES: {
  id: string;
  name: string;
  description: string;
  aspectRatio: AspectRatio;
  captionPreset: CaptionStylePreset;
  targetChannel: string;
}[] = [
  {
    id: 'tpl_podcast_vertical',
    name: 'Podcast Authority 9:16',
    description: 'High-contrast animated bottom captions with smoothed active-speaker crop.',
    aspectRatio: '9:16',
    captionPreset: 'modern_animated',
    targetChannel: 'TikTok · Reels · Shorts',
  },
  {
    id: 'tpl_bold_hook',
    name: 'Bold Center Hook',
    description: 'Uppercase kinetic center-frame captions tuned for fast spoken commentary.',
    aspectRatio: '9:16',
    captionPreset: 'bold_viral',
    targetChannel: 'YouTube Shorts · TikTok',
  },
  {
    id: 'tpl_linkedin_square',
    name: 'Executive Feed 1:1',
    description: 'Clean minimal subtitles framed cleanly for B2B LinkedIn timeline feeds.',
    aspectRatio: '1:1',
    captionPreset: 'minimal',
    targetChannel: 'LinkedIn · X',
  },
  {
    id: 'tpl_karaoke_45',
    name: 'Creator Portrait 4:5',
    description: 'Word-by-word karaoke fill captions optimized for Instagram 4:5 feed real estate.',
    aspectRatio: '4:5',
    captionPreset: 'karaoke',
    targetChannel: 'Instagram Feed',
  },
];

export function TemplatesView({ onApplyTemplate }: TemplatesViewProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-white">Studio Templates</h2>
        <p className="mt-1 text-sm text-slate-400">
          Apply paired aspect ratios and caption presets directly to the AI Editor.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {STUDIO_TEMPLATES.map((tpl) => (
          <div
            key={tpl.id}
            className="rounded-xl border border-white/10 bg-[#131720] p-6 flex flex-col justify-between gap-5"
          >
            <div>
              <p className="text-xs text-amber-400 tabular-nums">
                {tpl.aspectRatio} · {tpl.targetChannel}
              </p>
              <h3 className="mt-1.5 font-display text-lg font-semibold text-white">{tpl.name}</h3>
              <p className="mt-1.5 text-sm text-slate-300">{tpl.description}</p>
            </div>
            <button
              type="button"
              onClick={() => onApplyTemplate(tpl.captionPreset, tpl.aspectRatio)}
              className="self-start rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-white hover:bg-white/10 transition-colors"
            >
              Apply to AI Editor
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface BrandKitViewProps {
  brandKit: BrandKit;
  isAuthenticated: boolean;
  onSaveBrandKit: (next: BrandKit) => Promise<{ ok: boolean; message: string }>;
}

export function BrandKitView({
  brandKit,
  isAuthenticated,
  onSaveBrandKit,
}: BrandKitViewProps) {
  const [draft, setDraft] = useState<BrandKit>(brandKit);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setDraft(brandKit);
  }, [brandKit]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveFeedback(null);
    try {
      const result = await onSaveBrandKit(draft);
      setSaveFeedback({ ok: result.ok, text: result.message });
    } catch {
      setSaveFeedback({ ok: false, text: 'Unable to save Brand Kit changes right now.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="font-display text-xl font-semibold text-white">Brand Kit</h2>
        <p className="mt-1 text-sm text-slate-400">
          Configure workspace watermark handle, accent colors, and default caption styling.
          {isAuthenticated
            ? ' Changes sync automatically to your account.'
            : ' Sign in or create an account to save your Brand Kit across sessions.'}
        </p>
      </div>

      <form
        onSubmit={(e) => void handleSave(e)}
        className="rounded-xl border border-white/10 bg-[#131720] p-6 space-y-5"
      >
        <div>
          <label htmlFor="bk-name" className="block text-xs font-medium text-slate-300 mb-1.5">
            Kit name
          </label>
          <input
            id="bk-name"
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="w-full rounded-lg border border-white/15 bg-[#0B0D11] px-3.5 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="bk-watermark"
              className="block text-xs font-medium text-slate-300 mb-1.5"
            >
              Watermark handle
            </label>
            <input
              id="bk-watermark"
              type="text"
              value={draft.watermarkText}
              onChange={(e) => setDraft({ ...draft, watermarkText: e.target.value })}
              placeholder="@yourchannel"
              className="w-full rounded-lg border border-white/15 bg-[#0B0D11] px-3.5 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="bk-pos" className="block text-xs font-medium text-slate-300 mb-1.5">
              Watermark placement
            </label>
            <select
              id="bk-pos"
              value={draft.watermarkPosition}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  watermarkPosition: e.target.value as BrandKit['watermarkPosition'],
                })
              }
              className="w-full rounded-lg border border-white/15 bg-[#0B0D11] px-3.5 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
            >
              <option value="top_right">Top Right</option>
              <option value="top_left">Top Left</option>
              <option value="bottom_right">Bottom Right</option>
              <option value="none">Disabled</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="bk-accent" className="block text-xs font-medium text-slate-300 mb-1.5">
              Highlight accent color
            </label>
            <div className="flex items-center gap-3">
              <input
                id="bk-accent"
                type="color"
                value={draft.accentColor}
                onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })}
                className="h-9 w-12 rounded border border-white/15 bg-[#0B0D11] cursor-pointer"
              />
              <span className="font-mono text-xs text-slate-300">{draft.accentColor}</span>
            </div>
          </div>

          <div>
            <label htmlFor="bk-preset" className="block text-xs font-medium text-slate-300 mb-1.5">
              Default caption preset
            </label>
            <select
              id="bk-preset"
              value={draft.defaultCaptionPreset}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  defaultCaptionPreset: e.target.value as CaptionStylePreset,
                })
              }
              className="w-full rounded-lg border border-white/15 bg-[#0B0D11] px-3.5 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
            >
              {CAPTION_STYLES.map((s) => (
                <option key={s.id} value={s.preset}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60 transition-colors"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {saving ? 'Saving...' : 'Save Brand Kit'}
          </button>
          {saveFeedback && (
            <span
              role="status"
              className={`inline-flex items-center gap-1.5 text-xs ${
                saveFeedback.ok ? 'text-emerald-400' : 'text-red-300'
              }`}
            >
              {saveFeedback.ok ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {saveFeedback.text}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

interface SettingsViewProps {
  user: User;
  isAuthenticated: boolean;
  onOpenAuth: () => void;
  onSignOut: () => void;
}

export function SettingsView({
  user,
  isAuthenticated,
  onOpenAuth,
  onSignOut,
}: SettingsViewProps) {
  const [configStatus, setConfigStatus] = useState<SystemConfigStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/config/status')
      .then((r) => r.json())
      .then((data: SystemConfigStatus) => setConfigStatus(data))
      .catch(() => setLoadError('Unable to check studio capability status right now.'));
  }, []);

  const studioCapabilities = configStatus
    ? [
        {
          label: 'AI Analysis & Subtitle Translation',
          ready: configStatus.geminiConfigured,
          note: configStatus.geminiConfigured
            ? 'Highlight scoring, transcript alignment, social copy, and multi-language translation are active.'
            : 'Requires GEMINI_API_KEY configured in server environment secrets.',
        },
        {
          label: 'Video Probing & MP4 Render Engine',
          ready: configStatus.ffmpegAvailable,
          note: configStatus.ffmpegAvailable
            ? 'FFprobe validation, waveform extraction, burned-in captions, and 720p/1080p MP4 rendering are active.'
            : 'Requires FFmpeg installed on the media worker host.',
        },
        {
          label: 'Email & Google Account Sign-In',
          ready: configStatus.googleOAuthConfigured,
          note: configStatus.googleOAuthConfigured
            ? 'Email + password and Google Sign-In are active for syncing projects, edits, and Brand Kit preferences.'
            : 'Account authentication configuration is required.',
        },
      ]
    : [];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="font-display text-xl font-semibold text-white">Account &amp; Workspace</h2>
        <p className="mt-1 text-sm text-slate-400">
          Manage your ClipGenius session, account permissions, and creative studio capabilities.
        </p>
      </div>

      {/* Account & Session Card */}
      <section className="rounded-xl border border-white/10 bg-[#131720] p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg border border-white/10 bg-[#0B0D11] flex items-center justify-center shrink-0">
              {isAuthenticated ? (
                <UserCheck className="h-5 w-5 text-emerald-400" aria-hidden="true" />
              ) : (
                <ShieldCheck className="h-5 w-5 text-amber-400" aria-hidden="true" />
              )}
            </div>
            <div>
              <h3 className="font-display text-base font-semibold text-white">
                {isAuthenticated ? user.name : 'Sample Workspace Preview'}
              </h3>
              <p className="mt-0.5 text-xs text-slate-400">
                {isAuthenticated
                  ? `${user.email} · ${user.plan} plan · ${user.role ?? 'creator'} role`
                  : 'You are exploring ClipGenius without an account. Sign in or create an account to keep projects and Brand Kit settings.'}
              </p>
            </div>
          </div>

          <div className="shrink-0">
            {isAuthenticated ? (
              <button
                type="button"
                onClick={onSignOut}
                className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 hover:text-white transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                Sign Out
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenAuth}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors"
              >
                <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                Sign In / Create Account
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-white/10 pt-4 text-xs">
          <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-3">
            <p className="text-slate-400">Workspace Access</p>
            <p className="mt-1 font-medium text-white capitalize">
              {isAuthenticated ? `${user.role ?? 'creator'} (Owner-Scoped)` : 'Preview Mode'}
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-3">
            <p className="text-slate-400">Plan Tier</p>
            <p className="mt-1 font-medium text-white capitalize">{user.plan} Plan</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-3">
            <p className="text-slate-400">Export Links</p>
            <p className="mt-1 font-medium text-white">Expiring Signed Downloads (1h)</p>
          </div>
        </div>
      </section>

      {/* Studio Creative Capabilities */}
      <section className="space-y-3">
        <div>
          <h3 className="font-display text-base font-semibold text-white">
            Studio Capabilities
          </h3>
          <p className="mt-0.5 text-xs text-slate-400">
            Live availability of AI analysis, video rendering, and account authentication.
          </p>
        </div>

        {loadError && (
          <div
            role="alert"
            className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"
          >
            {loadError}
          </div>
        )}

        {!configStatus && !loadError ? (
          <div className="rounded-xl border border-white/10 bg-[#131720] p-6 text-sm text-slate-400">
            Checking studio capabilities...
          </div>
        ) : (
          <div className="rounded-xl border border-white/10 bg-[#131720] divide-y divide-white/10">
            {studioCapabilities.map((row) => (
              <div
                key={row.label}
                className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div>
                  <p className="text-sm font-medium text-white">{row.label}</p>
                  <p className="mt-0.5 text-xs text-slate-400">{row.note}</p>
                </div>
                <div className="flex items-center gap-2 text-xs font-medium shrink-0">
                  {row.ready ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                      <span className="text-emerald-300">Active</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" />
                      <span className="text-amber-300">Requires setup</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
