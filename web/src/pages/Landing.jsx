import {
  ArrowUpRight,
  Brain,
  CloudArrowUp,
  Cpu,
  Database,
  DropboxLogo,
  Fingerprint,
  Funnel,
  GoogleDriveLogo,
  ImagesSquare,
  Key,
  LinkSimple,
  LockKey,
  MagnifyingGlass,
  Queue,
  Receipt,
  ShieldCheck,
  Trash,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Bezel } from "../components/ui/Bezel";
import { Button } from "../components/ui/Button";
import { Reveal, RevealGroup, RevealItem } from "../components/ui/Reveal";
import { SignInButton } from "../components/layout/SignInButton";
import { useToast } from "../hooks/useToast";
import { easeSpring } from "../lib/motion";

const QUERIES = ["receipts from March", "sunset over the ocean", "my dog at the park", "whiteboard notes"];
const TILE_GRADIENTS = [
  "from-[#0f3d2e] via-[#0b5c46] to-[#1fb985]",
  "from-[#0a2a3a] via-[#0c4a63] to-[#1aa7c9]",
  "from-[#1c1c1c] via-[#2a3a33] to-[#4fd1a5]",
  "from-[#10202a] via-[#1d3d4f] to-[#00e5ff]",
  "from-[#13261f] via-[#20493a] to-[#7bf1c0]",
  "from-[#0e1a22] via-[#163444] to-[#5cc8e6]",
];

function AuthErrorNotice() {
  const [params, setParams] = useSearchParams();
  const { toast } = useToast();
  const reason = params.get("auth_error");
  useEffect(() => {
    if (!reason) return;
    const messages = { cancelled: "Sign-in was cancelled.", expired: "That sign-in link expired. Please try again.", unverified: "Your Google email isn't verified." };
    toast(messages[reason] || "Sign-in failed. Please try again.", { tone: "error" });
    setParams({}, { replace: true });
  }, [reason, toast, setParams]);
  return null;
}

function HeroDemo() {
  const reduce = useReducedMotion();
  const [qi, setQi] = useState(0);
  const [typed, setTyped] = useState(reduce ? QUERIES[0] : "");

  useEffect(() => {
    if (reduce) return;
    const full = QUERIES[qi];
    if (typed.length < full.length) {
      const t = setTimeout(() => setTyped(full.slice(0, typed.length + 1)), 55);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setTyped("");
      setQi((i) => (i + 1) % QUERIES.length);
    }, 2200);
    return () => clearTimeout(t);
  }, [typed, qi, reduce]);

  const done = typed === QUERIES[qi];

  return (
    <div className="bezel md:-rotate-[1.5deg]">
      <div className="bezel-core overflow-hidden p-4 sm:p-5">
        <div className="flex items-center gap-3 rounded-full bg-white/[0.04] px-4 py-3 ring-1 ring-white/10">
          <MagnifyingGlass size={16} weight="light" className="text-mist" />
          <span className="text-sm text-fog">
            {typed}
            <span className="ml-0.5 inline-block h-4 w-px translate-y-0.5 animate-pulse bg-mint" />
          </span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {TILE_GRADIENTS.map((g, i) => (
            <motion.div
              key={`${qi}-${i}`}
              className={`relative aspect-square overflow-hidden rounded-xl bg-gradient-to-br ${g}`}
              initial={reduce ? false : { opacity: 0.25, scale: 0.94 }}
              animate={{ opacity: done ? 1 : 0.25, scale: done ? 1 : 0.94 }}
              transition={{ duration: 0.6, delay: done ? i * 0.06 : 0, ease: easeSpring }}
            >
              {i % 2 === 0 ? (
                <span className="absolute bottom-1.5 left-1.5 rounded-full bg-ink/80 p-1">
                  <GoogleDriveLogo size={10} weight="fill" className="text-[#4f9cff]" />
                </span>
              ) : (
                <span className="absolute bottom-1.5 left-1.5 rounded-full bg-ink/80 p-1">
                  <DropboxLogo size={10} weight="fill" className="text-[#3d8bff]" />
                </span>
              )}
              <AnimatePresence>
                {done && (
                  <motion.span
                    className="absolute right-1.5 top-1.5 rounded-full bg-ink/80 px-1.5 py-0.5 font-mono text-[9px] text-mint"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ delay: 0.2 + i * 0.06, ease: easeSpring }}
                  >
                    {96 - i * 7}%
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

const features = [
  {
    span: "md:col-span-7 md:row-span-2",
    Icon: Brain,
    title: "Search by meaning",
    body: "SigLIP 2 embeds every image alongside language and auto-tags what it sees, while EXIF dates and cameras add the facts. Type “cafe receipt from March” and get the receipt, not files named IMG_4412.",
    visual: true,
  },
  { span: "md:col-span-5", Icon: ImagesSquare, title: "People & places", body: "Faces are grouped on-device so you can name people once. GPS becomes place names, offline." },
  { span: "md:col-span-5", Icon: Fingerprint, title: "Never upload twice", body: "Content hashing behind a Bloom filter catches duplicates before they cost you space." },
  { span: "md:col-span-4", Icon: Receipt, title: "Bills, totalled", body: "Gemini reads vendor, date and grand total from receipts and keeps a running tally." },
  { span: "md:col-span-4", Icon: CloudArrowUp, title: "Drop anywhere", body: "Drag images onto any screen. Progress follows each file from upload to searchable." },
  { span: "md:col-span-4", Icon: LockKey, title: "Your cloud, your files", body: "We store pointers and embeddings, never your photos. Revoke access in one click." },
];

const steps = [
  { Icon: CloudArrowUp, title: "Upload", note: "Streamed over TLS, size and type validated, hashed on arrival." },
  { Icon: Funnel, title: "Dedup gate", note: "Bloom filter + database check per user. Known content stops here." },
  { Icon: Queue, title: "Queue", note: "One durable job per file with retries and exponential backoff." },
  { Icon: Cpu, title: "Process", note: "Saved to storage, embedded and auto-tagged by SigLIP 2, receipts read by Gemini, all in parallel." },
  { Icon: Database, title: "Index", note: "Vector + pointer stored per user tenant. The staged copy is deleted." },
];

const principles = [
  { Icon: Key, title: "Encrypted grants", body: "Provider refresh tokens are sealed with AES-256-GCM before they touch the database." },
  { Icon: ShieldCheck, title: "Verified identity", body: "Server-side sessions in an httpOnly cookie, CSRF-checked. No client-supplied user IDs, ever." },
  { Icon: LockKey, title: "Least privilege", body: "Drive access is scoped to files OmniCloud created, nothing else in your account." },
  { Icon: LinkSimple, title: "Expiring media links", body: "Images are served through HMAC-signed URLs that expire, with private caching only." },
  { Icon: Brain, title: "Embeddings, not pixels", body: "The vector index holds numbers and hashes. Your images stay in your own cloud." },
  { Icon: Trash, title: "Nothing lingers", body: "Staged uploads are deleted after processing, and orphans are swept automatically." },
];

export default function Landing() {
  return (
    <>
      <AuthErrorNotice />
      {/* Hero — editorial split */}
      <section className="mx-auto grid min-h-[100dvh] max-w-6xl items-center gap-16 px-4 pb-20 pt-32 md:grid-cols-[1.15fr_1fr] md:pt-28">
        <div>
          <motion.span className="eyebrow" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: easeSpring }}>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-mint" /> Local, Drive + Dropbox, unified
          </motion.span>
          <motion.h1
            className="mt-7 text-balance text-5xl font-semibold leading-[0.95] tracking-[-0.045em] sm:text-6xl lg:text-[5.25rem]"
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1.1, delay: 0.05, ease: easeSpring }}
          >
            Every cloud.
            <br />
            <span className="text-gradient">One calm surface.</span>
          </motion.h1>
          <motion.p
            className="mt-7 max-w-lg text-pretty text-lg leading-relaxed text-mist"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.15, ease: easeSpring }}
          >
            One library for this machine, Google Drive and Dropbox. Ask for “Priya at the beach last summer”: it knows the faces, places and dates, skips duplicate uploads, and adds up your receipts.
          </motion.p>
          <motion.div
            className="mt-10 flex flex-wrap items-center gap-4"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.25, ease: easeSpring }}
          >
            <SignInButton />
            <Button href="#pipeline" variant="quiet" size="md">See how it works</Button>
          </motion.div>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 48 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.3, delay: 0.2, ease: easeSpring }}
        >
          <HeroDemo />
        </motion.div>
      </section>

      {/* Features — asymmetric bento */}
      <section id="features" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-24 md:py-36">
        <Reveal className="max-w-2xl">
          <span className="eyebrow">Features</span>
          <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">Less tab-hopping. More finding.</h2>
        </Reveal>
        <RevealGroup className="mt-14 grid auto-rows-[minmax(220px,auto)] grid-cols-1 gap-4 md:grid-cols-12">
          {features.map((f) => (
            <RevealItem key={f.title} className={f.span}>
              <Bezel className="h-full" coreClassName="flex h-full flex-col p-7 sm:p-8">
                <f.Icon size={28} weight="thin" className="text-mint" />
                <h3 className="mt-6 text-xl font-medium tracking-tight">{f.title}</h3>
                <p className="mt-2 max-w-md text-pretty text-sm leading-relaxed text-mist">{f.body}</p>
                {f.visual && (
                  <div className="mt-auto pt-10">
                    <div className="space-y-2 font-mono text-xs">
                      {[
                        ["“receipt from the cafe”", 0.94],
                        ["“friends at the beach”", 0.88],
                        ["“diagram on a whiteboard”", 0.81],
                      ].map(([q, s]) => (
                        <div key={q} className="flex items-center gap-3">
                          <span className="w-48 shrink-0 truncate text-mist">{q}</span>
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                            <span className="block h-full rounded-full bg-gradient-to-r from-mint to-aqua" style={{ width: `${s * 100}%` }} />
                          </span>
                          <span className="w-9 text-right text-mint">{s.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Bezel>
            </RevealItem>
          ))}
        </RevealGroup>
      </section>

      {/* Pipeline — z-axis cascade */}
      <section id="pipeline" className="scroll-mt-24 py-24 md:py-36">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal className="max-w-2xl">
            <span className="eyebrow">How it works</span>
            <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">From drop to searchable in seconds.</h2>
            <p className="mt-4 text-pretty text-mist">Each upload becomes a single durable job. If a step fails, it retries without redoing the work already done.</p>
          </Reveal>
          <RevealGroup className="mt-16 grid gap-4 md:grid-cols-5 md:gap-0" step={0.1}>
            {steps.map((s, i) => (
              <RevealItem
                key={s.title}
                className={`md:-ml-3 first:md:ml-0 ${["md:rotate-[-2deg]", "md:translate-y-6 md:rotate-[1.5deg]", "md:rotate-[-1deg]", "md:translate-y-8 md:rotate-[2deg]", "md:rotate-[-1.5deg]"][i]}`}
                style={{ zIndex: i + 1 }}
              >
                <Bezel coreClassName="p-6">
                  <div className="flex items-center justify-between">
                    <s.Icon size={26} weight="thin" className="text-aqua" />
                    <span className="font-mono text-[11px] text-haze">0{i + 1}</span>
                  </div>
                  <h3 className="mt-8 font-medium">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-mist">{s.note}</p>
                </Bezel>
              </RevealItem>
            ))}
          </RevealGroup>
        </div>
      </section>

      {/* Security */}
      <section id="security" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-24 md:py-36">
        <div className="grid gap-14 md:grid-cols-[0.9fr_1.1fr]">
          <Reveal className="md:sticky md:top-32 md:self-start">
            <span className="eyebrow">Security</span>
            <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">Built so we can&apos;t see your photos.</h2>
            <p className="mt-4 max-w-md text-pretty text-mist">
              OmniCloud is a lens over storage you already own. These are the guarantees the code enforces, not marketing promises.
            </p>
          </Reveal>
          <RevealGroup className="grid gap-4 sm:grid-cols-2">
            {principles.map((p) => (
              <RevealItem key={p.title}>
                <div className="h-full rounded-[1.5rem] bg-white/[0.02] p-6 ring-1 ring-white/[0.07]">
                  <p.Icon size={22} weight="light" className="text-mint" />
                  <h3 className="mt-5 font-medium">{p.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-mist">{p.body}</p>
                </div>
              </RevealItem>
            ))}
          </RevealGroup>
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 pb-32 pt-12">
        <Reveal className="mx-auto max-w-4xl">
          <Bezel coreClassName="relative overflow-hidden px-6 py-20 text-center sm:px-16">
            <div aria-hidden="true" className="absolute inset-x-0 -top-24 mx-auto h-48 w-2/3 rounded-full bg-mint/20 blur-[90px]" />
            <h2 className="relative text-balance text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">Bring your clouds together.</h2>
            <p className="relative mx-auto mt-4 max-w-md text-mist">Free while in beta. Connect a cloud in under a minute.</p>
            <div className="relative mt-10 flex justify-center">
              <SignInButton />
            </div>
          </Bezel>
        </Reveal>
      </section>
    </>
  );
}
