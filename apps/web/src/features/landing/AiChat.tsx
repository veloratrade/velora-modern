"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "../../contracts";

export interface AiCopy {
  greeting: string;
  questions: Record<string, string>;
  answers: Record<string, string>;
  intents: Record<string, string[]>;
  prompts: string[];
  insightPrompt: string;
  placeholder: string;
  send: string;
  freeAsk: { prefix: string; emphasis: string; suffix: string; button: string };
}

type Role = "user" | "ai" | "typing";
interface Msg {
  id: number;
  role: Role;
  text: string;
}

const AI_AV = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" fill="#e9c45c"/></svg>`;
const USER_AV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.4"/><path d="M4.5 20c1.2-3.2 4-5 7.5-5s6.3 1.8 7.5 5"/></svg>`;

function matchIntent(text: string, intents: AiCopy["intents"]): string {
  const lower = text.toLowerCase();
  for (const k of ["lose", "revenge", "edge", "setup"] as const) {
    const words = intents[k] ?? [];
    for (const w of words) if (w && lower.includes(w)) return k;
  }
  return "default";
}

function useSound() {
  const play = useCallback((kind: string) => {
    try {
      const key = "velora_ui_sounds";
      const enabled = (() => {
        try {
          return localStorage.getItem(key) !== "off";
        } catch {
          return true;
        }
      })();
      if (!enabled) return;
      const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      const tone = (freq: number, start: number, dur: number, vol: number, type: OscillatorType = "sine") => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, start);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(vol, start + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        o.connect(g).connect(ctx.destination);
        o.start(start);
        o.stop(start + dur + 0.02);
      };
      if (kind === "input") tone(740, now, 0.055, 0.01);
      else if (kind === "success") {
        tone(659.25, now, 0.24, 0.055);
        tone(987.77, now + 0.09, 0.38, 0.06);
      } else {
        tone(659.25, now, 0.2, 0.042);
        tone(880, now + 0.075, 0.31, 0.05);
      }
      setTimeout(() => {
        try {
          ctx.close();
        } catch {}
      }, 850);
    } catch {}
  }, []);
  return play;
}

export function AiChat({ locale: _locale, copy, greeting }: { locale: Locale; copy: AiCopy; greeting: string }) {
  void _locale;
  const [msgs, setMsgs] = useState<Msg[]>(() => [{ id: 1, role: "ai", text: greeting }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [typed, setTyped] = useState<Map<number, string>>(new Map());
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(2);
  const play = useSound();

  const placeholder = copy.prompts[placeholderIdx % copy.prompts.length] ?? copy.placeholder;

  useEffect(() => {
    const t = setInterval(() => {
      if (!input && document.activeElement !== inputRef.current) {
        setPlaceholderIdx((i) => (i + 1) % copy.prompts.length);
      }
    }, 3800);
    return () => clearInterval(t);
  }, [input, copy.prompts.length]);

  // Auto-demo when #ai enters viewport (like Legacy IntersectionObserver).
  useEffect(() => {
    const sec = document.getElementById("ai");
    if (!sec) return;
    let done = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !done) {
          done = true;
          setTimeout(() => void ask("lose"), 800);
          io.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(sec);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, typed]);

  const ask = useCallback(
    (kind: string, customText?: string) => {
      if (busy) return;
      setBusy(true);
      const qKey = kind as keyof typeof copy.questions;
      const userText = customText ?? copy.questions[qKey] ?? "…";
      const uid = idRef.current++;
      const tid = idRef.current++;
      setMsgs((m) => [...m, { id: uid, role: "user", text: userText }, { id: tid, role: "typing", text: "" }]);
      const answer: string = (copy.answers[kind] ?? copy.answers.default ?? "") as string;
      // Typing simulation: 750ms + random, then typewriter at ~13ms per 2 chars.
      setTimeout(
        () => {
          setMsgs((m) => m.filter((x) => x.id !== tid));
          const aid = idRef.current++;
          setMsgs((m) => [...m, { id: aid, role: "ai", text: answer }]);
          let i = 0;
          const tick = () => {
            i += 2;
            setTyped((prev) => {
              const next = new Map(prev);
              next.set(aid, (answer as string).slice(0, i));
              return next;
            });
            if (i < (answer as string).length) setTimeout(tick, 13);
            else {
              setTyped((prev) => {
                const next = new Map(prev);
                next.delete(aid);
                return next;
              });
              setBusy(false);
              inputRef.current?.focus();
            }
          };
          // start with empty to show caret, then tick.
          setTyped((prev) => {
            const next = new Map(prev);
            next.set(aid, "");
            return next;
          });
          tick();
          // Scroll after answer appears.
          bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
        },
        750 + Math.random() * 650,
      );
    },
    [busy, copy],
  );

  const onSend = useCallback(() => {
    const v = input.trim();
    if (!v) return;
    setInput("");
    const kind = matchIntent(v, copy.intents);
    ask(kind, v);
  }, [input, copy.intents, ask]);

  return (
    <>
      <div className="ai-body" id="aiBody" ref={bodyRef}>
        {msgs.map((m) => {
          if (m.role === "typing") {
            return (
              <div key={m.id} className="ai-msg ai">
                <div className="av" dangerouslySetInnerHTML={{ __html: AI_AV }} />
                <div className="bub ai-typing">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            );
          }
          if (m.role === "user") {
            return (
              <div key={m.id} className="ai-msg user">
                <div className="bub">{m.text}</div>
                <div className="av" dangerouslySetInnerHTML={{ __html: USER_AV }} />
              </div>
            );
          }
          const t = typed.get(m.id);
          const isTyping = t !== undefined;
          const display = isTyping ? t : m.text;
          return (
            <div key={m.id} className="ai-msg ai">
              <div className="av" dangerouslySetInnerHTML={{ __html: AI_AV }} />
              <div className="bub">
                {isTyping ? (
                  <>
                    {display
                      .split("\n")
                      .map((line, idx, arr) => (
                        <span key={idx}>
                          {line}
                          {idx < arr.length - 1 && <br />}
                        </span>
                      ))}
                    {isTyping && display.length < m.text.length && <span className="ai-caret" />}
                  </>
                ) : (
                  display.split("\n").map((line, idx, arr) => (
                    <span key={idx}>
                      {line}
                      {idx < arr.length - 1 && <br />}
                    </span>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="ai-chips" id="aiChips">
        {(["lose", "revenge", "edge", "setup"] as const).map((k) => (
          <button key={k} className="ai-chip" data-q={k} disabled={busy} onClick={() => ask(k)}>
            <span>{copy.questions[k]}</span>
          </button>
        ))}
      </div>
      <div className="ai-free-ask">
        <span>{copy.freeAsk.prefix}</span> <b>{copy.freeAsk.emphasis}</b> <span>{copy.freeAsk.suffix}</span>{" "}
        <button
          data-free-ask=""
          type="button"
          onClick={() => {
            inputRef.current?.focus();
            setPlaceholderIdx(0);
            play("modal");
          }}
        >
          {copy.freeAsk.button}
        </button>
      </div>
      <div className="ai-input">
        <input
          ref={inputRef}
          autoComplete="off"
          placeholder={placeholder}
          id="aiInput"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            play("input");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSend();
          }}
          disabled={busy}
          lang="en"
          dir="ltr"
          data-numbering="latn"
        />
        <button
          aria-label={copy.send}
          className="ai-send"
          id="aiSend"
          onClick={onSend}
          disabled={busy || !input.trim()}
        >
          <svg fill="currentColor" viewBox="0 0 24 24">
            <path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.993.993 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
          </svg>
        </button>
      </div>
      {/* Insight button handler via delegation: keep data-ai-insight compatibility */}
      <script
        // This inline script is never executed (Next strips it in prod without nonce).
        // The handler is attached via effect below for CSP compliance.
        type="application/json"
        dangerouslySetInnerHTML={{ __html: "{}" }}
      />
      <InsightBridge copy={copy} ask={ask} />
    </>
  );
}

function InsightBridge({ copy, ask }: { copy: AiCopy; ask: (k: string, t?: string) => void }) {
  useEffect(() => {
    const handler = () => ask("lose", copy.insightPrompt);
    const btns = document.querySelectorAll("[data-ai-insight]");
    btns.forEach((b) => b.addEventListener("click", handler));
    return () => btns.forEach((b) => b.removeEventListener("click", handler));
  }, [copy.insightPrompt, ask]);
  return null;
}
