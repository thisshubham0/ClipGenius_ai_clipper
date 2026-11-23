import { useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Film,
  Menu,
  Play,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { CAPTION_STYLES, HERO_STUDIO_IMAGE, SAMPLE_DEMO_CLIPS } from '../data/demoProject';
import { formatTimecode } from '../lib/scoring';
import type { CaptionStylePreset } from '../types/clipgenius';

interface LandingPageProps {
  isAuthenticated?: boolean;
  onOpenWorkspace?: () => void;
  onOpenAuth: (mode?: 'signin' | 'signup') => void;
  onEnterDemoStudio: (clipId?: string) => void;
}

const WORKFLOW_STEPS = [
  {
    num: '01.',
    title: 'Ingest & Probe',
    description:
      'Drop MP4, MOV, WebM, or MKV masters up to 4K, or import a link with rights verification. Server-side FFprobe inspects streams, fps, and duration before queuing.',
  },
  {
    num: '02.',
    title: 'Transcribe & Diarize',
    description:
      'Extract clean mono audio, align word-level timestamps, detect language, and separate individual speakers so clip cuts always land on natural sentence boundaries.',
  },
  {
    num: '03.',
    title: 'Score & Reframe',
    description:
      'Rank candidate hooks, insights, and emotional peaks with a six-criterion estimate, then apply smoothed active-speaker crop paths for 9:16, 1:1, or 4:5 frames.',
  },
  {
    num: '04.',
    title: 'Fine-Tune & Export',
    description:
      'Adjust trim handles, edit synced captions in five studio presets, review platform-specific titles and hashtags, and export 1080p MP4 or SRT/VTT subtitles.',
  },
];

const FAQ_ITEMS = [
  {
    q: 'Is the Viral Score a guarantee of views?',
    a: 'No. Every ClipGenius score is an editorial estimate built from six weighted criteria: hook strength, information value, emotional impact, audience interest, story completeness, and shareability. We display the exact rationale for each sub-score so you stay in control.',
  },
  {
    q: 'Which video formats and aspect ratios are supported?',
    a: 'You can upload MP4, MOV, WebM, and MKV files, or validate YouTube, Vimeo, and direct video links. Clips can be reframed into 9:16 vertical, 16:9 widescreen, 1:1 square, or 4:5 social feed ratios.',
  },
  {
    q: 'Will clips cut off speakers mid-word?',
    a: 'No. Candidate clip boundaries snap to word-level timestamps and sentence punctuation detected during transcription, and you can refine every start and end handle on the editor timeline.',
  },
  {
    q: 'What are the rules for importing external URLs?',
    a: 'URL ingestion requires confirming that you own or hold distribution rights for the source material. Downloaded assets are scoped strictly to your workspace.',
  },
  {
    q: 'How are my videos and AI calls kept private?',
    a: 'All media URLs are signed and owner-scoped, AI model keys never leave the server, and uploaded masters can be deleted from your project settings at any time.',
  },
];

export function LandingPage({
  isAuthenticated = false,
  onOpenWorkspace,
  onOpenAuth,
  onEnterDemoStudio,
}: LandingPageProps) {
  function handleStudioEntry(mode: 'signin' | 'signup') {
    if (isAuthenticated && onOpenWorkspace) {
      onOpenWorkspace();
      return;
    }
    onOpenAuth(mode);
  }
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState(SAMPLE_DEMO_CLIPS[0].id);
  const [previewCaptionPreset, setPreviewCaptionPreset] =
    useState<CaptionStylePreset>('modern_animated');
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('monthly');
  const [openFaqIdx, setOpenFaqIdx] = useState<number | null>(0);
  const [heroImageError, setHeroImageError] = useState(false);
  const [clipImageErrors, setClipImageErrors] = useState<Record<string, boolean>>({});

  const activeClip =
    SAMPLE_DEMO_CLIPS.find((c) => c.id === selectedClipId) ?? SAMPLE_DEMO_CLIPS[0];
  const activeCaptionStyle =
    CAPTION_STYLES.find((s) => s.preset === previewCaptionPreset) ?? CAPTION_STYLES[0];

  const pricingPlans = [
    {
      name: 'Starter',
      audience: 'For testing short-form workflows',
      price: billingCycle === 'monthly' ? 0 : 0,
      limits: [
        '60 source minutes per month',
        'Up to 500 MB per upload (MP4 / MOV / WebM)',
        '720p MP4 + SRT/VTT exports',
        '3 caption presets · 1 workspace',
      ],
      cta: 'Start Free',
      featured: false,
    },
    {
      name: 'Creator',
      audience: 'For weekly podcasters and YouTubers',
      price: billingCycle === 'monthly' ? 29 : 23,
      limits: [
        '300 source minutes per month',
        'Up to 4 GB per upload (4K masters)',
        '1080p MP4 + batch ZIP + SRT/VTT',
        'All 5 caption presets · 1 Brand Kit',
      ],
      cta: 'Choose Creator',
      featured: true,
    },
    {
      name: 'Studio',
      audience: 'For agencies and multi-show teams',
      price: billingCycle === 'monthly' ? 79 : 64,
      limits: [
        '1,200 source minutes per month',
        'Up to 10 GB per upload · Priority queue',
        '1080p MP4 + multi-language subtitles',
        '5 Brand Kits · Team workspace ready',
      ],
      cta: 'Choose Studio',
      featured: false,
    },
  ];

  return (
    <div className="min-h-screen bg-[#0B0D11] text-[#F3F4F6]">
      {/* Strict 3-zone Top Bar Contract */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0B0D11]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-8 px-6 py-3.5">
          <a
            href="#top"
            className="font-display text-lg font-semibold tracking-tight text-white whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
          >
            ClipGenius
          </a>

          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-300"
          >
            <a
              href="#workflow"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
            >
              Workflow
            </a>
            <a
              href="#capabilities"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
            >
              Capabilities
            </a>
            <a
              href="#examples"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
            >
              Examples
            </a>
            <a
              href="#pricing"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
            >
              Pricing
            </a>
            <a
              href="#faq"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
            >
              FAQ
            </a>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => handleStudioEntry('signin')}
              className="hidden md:inline-flex items-center justify-center rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
            >
              {isAuthenticated ? 'Return to Workspace' : 'Open Studio'}
            </button>

            <button
              type="button"
              aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="md:hidden inline-flex h-11 w-11 items-center justify-center rounded-lg border border-white/15 text-slate-200 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden border-t border-white/10 bg-[#11151C] px-6 py-4 space-y-3">
            <nav aria-label="Mobile navigation" className="flex flex-col gap-2 text-sm">
              {[
                ['Workflow', '#workflow'],
                ['Capabilities', '#capabilities'],
                ['Examples', '#examples'],
                ['Pricing', '#pricing'],
                ['FAQ', '#faq'],
              ].map(([label, href]) => (
                <a
                  key={href}
                  href={href}
                  onClick={() => setMobileMenuOpen(false)}
                  className="py-2 text-slate-200 hover:text-white"
                >
                  {label}
                </a>
              ))}
            </nav>
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                handleStudioEntry('signin');
              }}
              className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400"
            >
              {isAuthenticated ? 'Return to Workspace' : 'Open Studio'}
            </button>
          </div>
        )}
      </header>

      <main id="top">
        {/* Hero Section */}
        <section className="mx-auto max-w-[1200px] px-6 pt-12 pb-16 lg:pt-16 lg:pb-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
            <div className="lg:col-span-5 flex flex-col justify-center">
              <p className="text-sm font-medium text-amber-400 mb-3">
                Long-form video to social-ready shorts
              </p>
              <h1 className="font-display text-[clamp(2.25rem,4vw,3.5rem)] font-semibold leading-[1.08] tracking-tight text-white [text-wrap:balance]">
                Turn long recordings into ranked, captioned clips
              </h1>
              <p className="mt-5 text-base leading-relaxed text-slate-300 max-w-xl">
                Upload a podcast, interview, or keynote. ClipGenius transcribes every word, scores
                candidate moments with transparent criteria, tracks the active speaker in 9:16, and
                opens a fast timeline editor for final cuts.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => handleStudioEntry('signup')}
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-5 py-3 text-sm font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                >
                  {isAuthenticated ? 'Return to Workspace' : 'Start Clipping Free'}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onEnterDemoStudio()}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-5 py-3 text-sm font-medium text-white hover:bg-white/10 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  <Play className="h-4 w-4 text-amber-400" aria-hidden="true" />
                  Inspect Sample Editor
                </button>
              </div>

              <p className="mt-6 text-xs text-slate-400 tabular-nums">
                MP4, MOV, WebM, MKV · 9:16, 16:9, 1:1, 4:5 · SRT &amp; VTT export
              </p>
            </div>

            <div className="lg:col-span-7 flex">
              <div className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-[#131720] min-h-[260px] sm:min-h-[340px] lg:min-h-[420px]">
                {!heroImageError ? (
                  <img
                    src={HERO_STUDIO_IMAGE}
                    alt="Podcast and cinema production studio configured for multi-format short clip extraction"
                    referrerPolicy="no-referrer"
                    onError={() => setHeroImageError(true)}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-[#161B24] to-[#0D1017] p-8 text-center">
                    <Film className="h-10 w-10 text-amber-400 mb-3" />
                    <p className="text-sm font-medium text-slate-200">
                      ClipGenius Production Studio Preview
                    </p>
                  </div>
                )}

                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0B0D11] via-[#0B0D11]/75 sm:via-[#0B0D11]/40 to-transparent"
                />

                <div className="absolute inset-x-0 bottom-0 p-5 sm:p-6 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium text-amber-300">
                      Sample Demo Project · Illustrative Breakdown
                    </p>
                    <p className="mt-1 font-display text-lg font-semibold text-white">
                      Founders Roundtable Ep. 42
                    </p>
                    <p className="mt-0.5 text-xs text-slate-300 tabular-nums">
                      45:42 master · 3840x2160 · 3 speakers · 3 ranked clips
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onEnterDemoStudio(SAMPLE_DEMO_CLIPS[0].id)}
                    className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-[#0B0D11]/85 px-4 py-2 text-xs font-semibold text-white hover:bg-[#171C26] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                  >
                    Open in AI Editor
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 01-04 Workflow Section */}
        <section id="workflow" className="border-t border-white/10 bg-[#0E1117] py-16 lg:py-20">
          <div className="mx-auto max-w-[1200px] px-6">
            <div className="max-w-2xl">
              <p className="text-sm font-medium text-amber-400">How it works</p>
              <h2 className="mt-2 font-display text-2xl sm:text-3xl font-semibold tracking-tight text-white [text-wrap:balance]">
                One deterministic pipeline from raw master to platform-ready clip
              </h2>
            </div>

            <div className="mt-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {WORKFLOW_STEPS.map((step) => (
                <div
                  key={step.num}
                  className="rounded-xl border border-white/10 bg-[#131720] p-6 flex flex-col justify-between"
                >
                  <div>
                    <span className="font-mono text-sm font-semibold text-amber-400 tabular-nums">
                      {step.num}
                    </span>
                    <h3 className="mt-3 font-display text-lg font-semibold text-white">
                      {step.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-300">
                      {step.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Capabilities Bento Section */}
        <section id="capabilities" className="border-t border-white/10 py-16 lg:py-20">
          <div className="mx-auto max-w-[1200px] px-6">
            <div className="max-w-2xl">
              <p className="text-sm font-medium text-amber-400">Core capabilities</p>
              <h2 className="mt-2 font-display text-2xl sm:text-3xl font-semibold tracking-tight text-white [text-wrap:balance]">
                Built for editors who want speed without black-box guesses
              </h2>
            </div>

            <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Marquee Bento Card 1: Explainable Scoring */}
              <div className="md:col-span-2 rounded-xl border border-white/10 bg-[#131720] p-6 sm:p-8">
                <div className="flex flex-wrap items-baseline justify-between gap-4">
                  <div>
                    <h3 className="font-display text-xl font-semibold text-white">
                      Transparent Six-Criterion Viral Score
                    </h3>
                    <p className="mt-1 text-sm text-slate-300">
                      Every score is decomposed into weighted signals with a one-line explanation.
                      Estimate only — never a promise of algorithmic reach.
                    </p>
                  </div>
                  <div className="text-right tabular-nums">
                    <span className="font-mono text-2xl font-semibold text-amber-400">
                      {SAMPLE_DEMO_CLIPS[0].score.overallEstimate}
                    </span>
                    <span className="text-sm text-slate-400"> / 100 est.</span>
                  </div>
                </div>

                <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
                  {SAMPLE_DEMO_CLIPS[0].score.criteria.map((c) => (
                    <div key={c.key}>
                      <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="font-medium text-slate-200">
                          {c.label} ({Math.round(c.weight * 100)}%)
                        </span>
                        <span className="font-mono text-slate-300 tabular-nums">{c.score}/100</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-amber-500"
                          style={{ width: `${c.score}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{c.rationale}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Bento Card 2: Reframing */}
              <div className="rounded-xl border border-white/10 bg-[#131720] p-6 sm:p-8 flex flex-col justify-between">
                <div>
                  <h3 className="font-display text-xl font-semibold text-white">
                    Smoothed Speaker Reframing
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-300">
                    Face and active-speaker tracking keeps subjects centered in 9:16, 1:1, or 4:5
                    without sudden camera jitter. Override crop offsets manually anytime.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-white/10 text-xs text-slate-400 tabular-nums">
                  Supported ratios · 9:16 · 16:9 · 1:1 · 4:5
                </div>
              </div>

              {/* Bento Card 3: Captions */}
              <div className="rounded-xl border border-white/10 bg-[#131720] p-6 sm:p-8 flex flex-col justify-between">
                <div>
                  <h3 className="font-display text-xl font-semibold text-white">
                    Word-Synced Studio Captions
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-300">
                    Switch between Modern Animated, Bold Viral, Minimal, Word Highlight, and Karaoke
                    styles. Fix any transcript word with immediate live preview.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-white/10 text-xs text-slate-400">
                  Presets · Custom font, stroke, position &amp; SRT/VTT
                </div>
              </div>

              {/* Marquee Bento Card 4: Multi-Platform AI Copy */}
              <div className="md:col-span-2 rounded-xl border border-white/10 bg-[#131720] p-6 sm:p-8">
                <h3 className="font-display text-xl font-semibold text-white">
                  Platform-Specific Titles, Hooks &amp; Captions
                </h3>
                <p className="mt-2 text-sm text-slate-300 max-w-2xl">
                  Each clip ships with a primary title, three alternatives, opening hook ideas,
                  hashtags, and tailored copy for TikTok, Reels, YouTube Shorts, and LinkedIn.
                </p>
                <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-4">
                    <p className="font-medium text-amber-400">YouTube Shorts Title</p>
                    <p className="mt-1.5 text-slate-200">
                      {SAMPLE_DEMO_CLIPS[0].metadata.primaryTitle}
                    </p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-4">
                    <p className="font-medium text-amber-400">LinkedIn Post Draft</p>
                    <p className="mt-1.5 text-slate-300 line-clamp-2">
                      {SAMPLE_DEMO_CLIPS[0].metadata.platformCaptions.linkedin}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Interactive Example Clips Showcase (Clearly Labeled Sample Demo Project) */}
        <section id="examples" className="border-t border-white/10 bg-[#0E1117] py-16 lg:py-20">
          <div className="mx-auto max-w-[1200px] px-6">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-amber-400">
                  Sample Demo Project · Illustrative Output
                </p>
                <h2 className="mt-2 font-display text-2xl sm:text-3xl font-semibold tracking-tight text-white">
                  Inspect ranked clips before uploading your first file
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onEnterDemoStudio(activeClip.id)}
                className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              >
                <SlidersHorizontal className="h-4 w-4 text-amber-400" aria-hidden="true" />
                Edit Selected Clip in Studio
              </button>
            </div>

            <div className="mt-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* Clip selector list */}
              <div className="lg:col-span-5 space-y-3">
                {SAMPLE_DEMO_CLIPS.map((clip, idx) => {
                  const isSelected = clip.id === activeClip.id;
                  const duration = Math.round(clip.endSec - clip.startSec);
                  return (
                    <button
                      key={clip.id}
                      type="button"
                      onClick={() => {
                        setSelectedClipId(clip.id);
                        setPreviewCaptionPreset(clip.captionStyle);
                      }}
                      className={`w-full text-left rounded-xl border p-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                        isSelected
                          ? 'border-amber-500/70 bg-[#171C26]'
                          : 'border-white/10 bg-[#131720] hover:border-white/25'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xs text-slate-400 tabular-nums">
                            Clip 0{idx + 1} · {formatTimecode(clip.startSec)}–
                            {formatTimecode(clip.endSec)} ({duration}s) · {clip.speaker}
                          </p>
                          <h3 className="mt-1.5 font-display text-base font-semibold text-white">
                            {clip.title}
                          </h3>
                        </div>
                        <div className="text-right shrink-0 tabular-nums">
                          <span className="font-mono text-lg font-semibold text-amber-400">
                            {clip.score.overallEstimate}
                          </span>
                          <p className="text-[11px] text-slate-400">est.</p>
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-slate-300 line-clamp-2">
                        {clip.score.summary}
                      </p>
                    </button>
                  );
                })}

                <p className="pt-2 text-xs text-slate-400">
                  Note: {activeClip.score.disclaimer}
                </p>
              </div>

              {/* Live Vertical Preview + Caption Preset Switcher */}
              <div className="lg:col-span-7 rounded-xl border border-white/10 bg-[#131720] p-6 sm:p-8 grid grid-cols-1 sm:grid-cols-12 gap-6 items-center">
                <div className="sm:col-span-5 flex justify-center">
                  <div className="relative aspect-[9/16] w-full max-w-[240px] overflow-hidden rounded-xl border border-white/15 bg-[#0B0D11]">
                    {!clipImageErrors[activeClip.id] ? (
                      <img
                        src={activeClip.thumbnailUrl}
                        alt={activeClip.title}
                        referrerPolicy="no-referrer"
                        onError={() =>
                          setClipImageErrors((prev) => ({ ...prev, [activeClip.id]: true }))
                        }
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-slate-900 p-4 text-center text-xs text-slate-400">
                        {activeClip.title}
                      </div>
                    )}
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/25"
                    />
                    <div
                      className={`absolute inset-x-4 ${
                        activeCaptionStyle.position === 'center' ? 'top-1/2 -translate-y-1/2' : 'bottom-6'
                      } text-center`}
                    >
                      <p
                        style={{
                          color: activeCaptionStyle.primaryColor,
                          textShadow: `0 2px 10px ${activeCaptionStyle.strokeColor}`,
                        }}
                        className={`font-display text-sm font-bold leading-snug ${
                          activeCaptionStyle.uppercase ? 'uppercase tracking-wide' : ''
                        }`}
                      >
                        <span style={{ color: activeCaptionStyle.highlightColor }}>
                          {activeClip.captionText.split(' ').slice(0, 3).join(' ')}{' '}
                        </span>
                        {activeClip.captionText.split(' ').slice(3).join(' ')}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="sm:col-span-7 space-y-5">
                  <div>
                    <p className="text-xs font-medium text-slate-400">Caption style preview</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {CAPTION_STYLES.map((style) => (
                        <button
                          key={style.id}
                          type="button"
                          onClick={() => setPreviewCaptionPreset(style.preset)}
                          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                            previewCaptionPreset === style.preset
                              ? 'bg-amber-500 text-slate-950 font-semibold'
                              : 'bg-white/5 text-slate-300 hover:bg-white/10'
                          }`}
                        >
                          {style.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 border-t border-white/10 pt-4">
                    <p className="text-xs font-medium text-slate-400">
                      Top scoring factors (Estimate)
                    </p>
                    {activeClip.score.criteria.slice(0, 3).map((item) => (
                      <div key={item.key} className="text-xs">
                        <div className="flex justify-between text-slate-200 tabular-nums">
                          <span>{item.label}</span>
                          <span className="font-mono text-amber-400">{item.score}/100</span>
                        </div>
                        <p className="text-slate-400 mt-0.5">{item.rationale}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing Section */}
        <section id="pricing" className="border-t border-white/10 py-16 lg:py-20">
          <div className="mx-auto max-w-[1200px] px-6">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6">
              <div>
                <p className="text-sm font-medium text-amber-400">Pricing</p>
                <h2 className="mt-2 font-display text-2xl sm:text-3xl font-semibold tracking-tight text-white">
                  Predictable monthly minutes with zero hidden render fees
                </h2>
              </div>

              <div
                role="group"
                aria-label="Billing interval"
                className="inline-flex rounded-lg border border-white/10 bg-[#131720] p-1 self-start"
              >
                <button
                  type="button"
                  onClick={() => setBillingCycle('monthly')}
                  className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    billingCycle === 'monthly'
                      ? 'bg-white text-slate-950'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Monthly
                </button>
                <button
                  type="button"
                  onClick={() => setBillingCycle('annual')}
                  className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    billingCycle === 'annual'
                      ? 'bg-white text-slate-950'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Annual (Save 20%)
                </button>
              </div>
            </div>

            <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-6">
              {pricingPlans.map((plan) => (
                <div
                  key={plan.name}
                  className={`rounded-xl border p-6 sm:p-8 flex flex-col justify-between ${
                    plan.featured
                      ? 'border-amber-500/60 bg-[#151A24]'
                      : 'border-white/10 bg-[#131720]'
                  }`}
                >
                  <div>
                    <h3 className="font-display text-xl font-semibold text-white">{plan.name}</h3>
                    <p className="mt-1 text-xs text-slate-400">{plan.audience}</p>
                    <div className="mt-5 flex items-baseline gap-1 tabular-nums">
                      <span className="font-display text-4xl font-semibold text-white">
                        ${plan.price}
                      </span>
                      <span className="text-sm text-slate-400">/ month</span>
                    </div>
                    <ul className="mt-6 space-y-3 border-t border-white/10 pt-6 text-sm text-slate-300">
                      {plan.limits.map((limit) => (
                        <li key={limit} className="flex items-start gap-2.5">
                          <Check
                            className="h-4 w-4 text-amber-400 shrink-0 mt-0.5"
                            aria-hidden="true"
                          />
                          <span>{limit}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenAuth('signup')}
                    className={`mt-8 w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                      plan.featured
                        ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                        : 'border border-white/15 bg-white/5 text-white hover:bg-white/10'
                    }`}
                  >
                    {plan.cta}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ Section */}
        <section id="faq" className="border-t border-white/10 bg-[#0E1117] py-16 lg:py-20">
          <div className="mx-auto max-w-[900px] px-6">
            <h2 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-white">
              Frequently asked questions
            </h2>
            <div className="mt-8 divide-y divide-white/10 border-y border-white/10">
              {FAQ_ITEMS.map((item, idx) => {
                const isOpen = openFaqIdx === idx;
                return (
                  <div key={item.q}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setOpenFaqIdx(isOpen ? null : idx)}
                      className="flex w-full items-center justify-between gap-4 py-5 text-left text-base font-medium text-white hover:text-amber-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                    >
                      <span>{item.q}</span>
                      <ChevronDown
                        className={`h-4 w-4 text-slate-400 shrink-0 transition-transform duration-150 ${
                          isOpen ? 'rotate-180' : ''
                        }`}
                        aria-hidden="true"
                      />
                    </button>
                    {isOpen && (
                      <p className="pb-5 text-sm leading-relaxed text-slate-300">{item.a}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 py-10">
        <div className="mx-auto max-w-[1200px] px-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-slate-400">
          <div>
            <span className="font-display text-sm font-semibold text-white">ClipGenius AI</span>
            <span className="mx-2" aria-hidden="true">
              ·
            </span>
            <span>Transparent video clipping &amp; editing studio</span>
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <a href="#workflow" className="hover:text-white">
              Workflow
            </a>
            <a href="#pricing" className="hover:text-white">
              Pricing
            </a>
            <button
              type="button"
              onClick={() => handleStudioEntry('signin')}
              className="hover:text-white"
            >
              {isAuthenticated ? 'Open Workspace' : 'Sign In'}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
