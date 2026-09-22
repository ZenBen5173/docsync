// Avery, the hover guide. Mounted ONCE in the root layout. It listens to the document (no per-component
// handlers): any element opts in with data-guide="key", or passes a ready sentence with data-guide-say.
// It stores the KEY, never the text, and recomputes the line on every render so it follows the app's state.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "motion/react";
import { SPRING } from "@/lib/motion";
import { explain, GUIDE_NAME, type GuideTheme } from "@/guide/explain";
import { useGuideCtx } from "@/guide/ctx";

const REST_MS = 180;        // the pointer has to rest this long before Avery speaks
const LINGER_MS = 4000;     // the line stays this long after the pointer leaves
const MARGIN = 18;
const W = 340, H = 300;     // a fixed stage: the character is pinned to its corner, so the bubble growing never moves it
const BODY_PX = 56;
const SLEEP_KEY = "doccheck.guide.asleep";
type Corner = "br" | "bl" | "tr" | "tl";
type Target = { el: Element; id: number };

const BODY: Record<GuideTheme, string> = {
  brand: "var(--brand)", ok: "#188038", mismatch: "#c5221f", review: "#e08a00", failed: "#5f6368", neutral: "#3c4a50",
};

export function Guide() {
  // Render nothing on touch devices: there is no "resting pointer" to react to.
  const [enabled] = useState(() => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  return enabled ? <GuideInner /> : null;
}

function GuideInner() {
  const ctx = useGuideCtx();
  const reduce = useReducedMotion();
  const bounce = useAnimationControls();
  const [asleep, setAsleep] = useState(() => { try { return localStorage.getItem(SLEEP_KEY) === "1"; } catch { return false; } });
  const [target, setTarget] = useState<Target | null>(null);
  const [hello, setHello] = useState(true);
  const [corner, setCorner] = useState<Corner>("br");
  const [blink, setBlink] = useState(false);
  const [bubbleH, setBubbleH] = useState(120);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });

  const root = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const eyes = useRef<SVGGElement>(null);
  const shown = useRef<Element | null>(null);       // the element whose line is on screen
  const pending = useRef<Element | null>(null);     // the element the pointer is over right now
  const rest = useRef<number | undefined>(undefined);
  const linger = useRef<number | undefined>(undefined);
  const seq = useRef(0);

  // ---- one listener for the whole app --------------------------------------------------------
  useEffect(() => {
    const over = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || root.current?.contains(t)) return;                        // never explain (or run away from) itself
      const el = t.closest?.("[data-guide],[data-guide-say]") ?? null;
      if (el === pending.current) return;
      pending.current = el;
      window.clearTimeout(rest.current);
      window.clearTimeout(linger.current);
      if (!el) { linger.current = window.setTimeout(() => { shown.current = null; setTarget(null); }, LINGER_MS); return; }
      if (el === shown.current) return;                                   // came back to the same thing: keep the line, no replay
      rest.current = window.setTimeout(() => { shown.current = el; setHello(false); setTarget({ el, id: ++seq.current }); }, REST_MS);
    };
    document.addEventListener("pointerover", over, { passive: true });
    return () => { document.removeEventListener("pointerover", over); window.clearTimeout(rest.current); window.clearTimeout(linger.current); };
  }, []);

  useEffect(() => { const t = window.setTimeout(() => setHello(false), 7000); return () => window.clearTimeout(t); }, []);   // hello, once
  useEffect(() => { const r = () => setVp({ w: window.innerWidth, h: window.innerHeight }); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, []);

  // eyes follow the cursor (direct style writes: no re-render per mouse move) and blink now and then
  useEffect(() => {
    if (asleep) return;
    let raf = 0, t = 0;
    const move = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = root.current?.querySelector("[data-git-body]")?.getBoundingClientRect();
        if (!r || !eyes.current) return;
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy) || 1, reach = Math.min(1, d / 240);
        eyes.current.style.transform = `translate(${((dx / d) * 3.6 * reach).toFixed(2)}px, ${((dy / d) * 2.8 * reach).toFixed(2)}px)`;
      });
    };
    const loop = () => { t = window.setTimeout(() => { setBlink(true); window.setTimeout(() => setBlink(false), 130); loop(); }, 2400 + Math.random() * 3600); };
    document.addEventListener("pointermove", move, { passive: true });
    loop();
    return () => { document.removeEventListener("pointermove", move); cancelAnimationFrame(raf); window.clearTimeout(t); };
  }, [asleep]);

  // ---- the line: recomputed on EVERY render from the element's key ----------------------------
  let line: { text: string; theme: GuideTheme } | null = null;
  if (!asleep) {
    if (target && target.el.isConnected) {
      const say = target.el.getAttribute("data-guide-say");
      const key = target.el.getAttribute("data-guide");
      if (say) line = { text: say, theme: (target.el.getAttribute("data-guide-theme") as GuideTheme) || "brand" };
      else if (key) line = explain(key, ctx);                             // unknown key -> null -> Avery stays quiet
    } else if (hello) line = explain("guide:hello", ctx);
  }
  const lineId = line ? (target && target.el.isConnected ? target.id : -1) : 0;
  const theme: GuideTheme = line?.theme ?? "brand";

  // a little hop whenever a NEW line starts
  useEffect(() => { if (lineId && !reduce) bounce.start({ y: [0, -10, 0], scale: [1, 1.09, 1], transition: { duration: 0.42, ease: [0.16, 1, 0.3, 1] } }); }, [lineId, reduce, bounce]);

  // ---- never cover what it explains ------------------------------------------------------------
  useLayoutEffect(() => { const h = bubble.current?.offsetHeight; if (h && Math.abs(h - bubbleH) > 2) setBubbleH(h); });
  const place = (c: Corner) => ({ x: c === "br" || c === "tr" ? vp.w - W - MARGIN : MARGIN, y: c === "br" || c === "bl" ? vp.h - H - MARGIN : MARGIN + 56 });
  useLayoutEffect(() => {
    if (!target || !line || !target.el.isConnected) return;
    const t = target.el.getBoundingClientRect(), used = BODY_PX + 10 + bubbleH, pad = 10;
    const hits = (c: Corner) => {
      const p = place(c), top = c === "br" || c === "bl" ? p.y + H - used : p.y;
      return !(t.right < p.x - pad || t.left > p.x + W + pad || t.bottom < top - pad || t.top > top + used + pad);
    };
    // home is bottom-right: go back there as soon as it is clear, otherwise stay put, otherwise move away
    const fx: Record<Corner, Corner> = { br: "bl", bl: "br", tr: "tl", tl: "tr" }, fy: Record<Corner, Corner> = { br: "tr", tr: "br", bl: "tl", tl: "bl" };
    const next = (["br", corner, fx[corner], fy[corner], fy[fx[corner]]] as Corner[]).find((c) => !hits(c));
    if (next && next !== corner) setCorner(next);
  }, [target, lineId, bubbleH, vp.w, vp.h]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => setAsleep((v) => { const n = !v; try { localStorage.setItem(SLEEP_KEY, n ? "1" : "0"); } catch { /* private mode */ } return n; });
  const pos = place(corner), right = corner === "br" || corner === "tr", bottom = corner === "br" || corner === "bl";
  const words = line ? line.text.split(" ") : [];

  return (
    <motion.div ref={root} className="no-print pointer-events-none fixed left-0 top-0 z-[85] flex gap-2.5" initial={false}
      style={{ width: W, height: H, maxWidth: "calc(100vw - 36px)", flexDirection: bottom ? "column" : "column-reverse", justifyContent: "flex-end", alignItems: right ? "flex-end" : "flex-start" }}
      animate={{ x: pos.x, y: pos.y }} transition={reduce ? { duration: 0 } : SPRING.soft}>
      <div role="status" aria-live="polite" className="flex w-full" style={{ justifyContent: right ? "flex-end" : "flex-start" }}>
        <AnimatePresence mode="wait">
          {line && (
            <motion.div ref={bubble} key={lineId} initial={{ opacity: 0, y: bottom ? 8 : -8, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.16 }}
              className="max-w-[320px] rounded-2xl border bg-popover px-3.5 py-2.5 text-[13px] leading-[1.45] text-popover-foreground shadow-[0_8px_28px_rgba(0,0,0,.16)]"
              style={{ borderColor: `color-mix(in srgb, ${BODY[theme]} 40%, var(--border))` }}>
              {words.map((w, i) => (
                <motion.span key={`${lineId}-${i}`} initial={reduce ? false : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: reduce ? 0 : Math.min(i * 0.022, 1.2), duration: 0.16 }} className="inline-block whitespace-pre">{w + " "}</motion.span>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* A real button. The bob lives on an INNER element, so the button itself stays still and easy to click. */}
      <button type="button" onClick={toggle} aria-pressed={asleep} title={asleep ? `Wake ${GUIDE_NAME}` : `Put ${GUIDE_NAME} to sleep`}
        aria-label={asleep ? `${GUIDE_NAME}, the guide, is asleep. Press to wake it.` : `${GUIDE_NAME}, the guide, is awake. Press to put it to sleep.`}
        className="pointer-events-auto grid shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ width: BODY_PX, height: BODY_PX }}>
        <motion.div animate={bounce}>
          <div className={asleep || reduce ? undefined : "git-bob"}>
            <svg data-git-body viewBox="0 0 56 56" width="52" height="52" aria-hidden className="block drop-shadow-[0_4px_8px_rgba(0,0,0,.22)]">
              <circle cx="28" cy="28" r="25" style={{ fill: BODY[asleep ? "neutral" : theme], transition: "fill .35s ease" }} />
              <ellipse cx="20" cy="16" rx="11" ry="6.5" fill="#fff" opacity=".16" />
              <g ref={eyes} style={{ transition: "transform .12s ease-out" }}>
                {asleep ? (
                  <>
                    <path d="M15 29 q5 4.5 10 0" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
                    <path d="M31 29 q5 4.5 10 0" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
                    <text x="40" y="15" fontSize="10" fontWeight="700" fill="#fff" opacity=".85">z</text>
                  </>
                ) : (
                  <g style={{ transformOrigin: "28px 27px", transform: `scaleY(${blink ? 0.08 : 1})`, transition: "transform .09s ease-in" }}>
                    <ellipse cx="20" cy="27" rx="4.6" ry="8.6" fill="#fff" />
                    <ellipse cx="36" cy="27" rx="4.6" ry="8.6" fill="#fff" />
                  </g>
                )}
              </g>
            </svg>
          </div>
        </motion.div>
      </button>
    </motion.div>
  );
}
