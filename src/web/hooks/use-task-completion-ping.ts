import { useEffect, useRef, useState } from "react";
import type { Job } from "../lib/types.js";

type NoticeStatus = "SUCCESS" | "FAILED" | "ESCALATING";
type TicketNotice = { id: string; status: NoticeStatus; title: string; description: string };
const signals = {
  SUCCESS: { title: "Ticket completed", notes: [659, 784, 1047], duration: 0.24 },
  FAILED: { title: "Ticket failed", notes: [440, 330, 220], duration: 0.32 },
  ESCALATING: { title: "Ticket escalated", notes: [523, 784, 523, 784], duration: 0.20 },
};

/** Announces ticket completion, failure and escalation with distinct, audible alerts. */
export function useTaskCompletionPing(jobs: Job[], projectId: string) {
  const known = useRef(new Map<string, string>());
  const audio = useRef<AudioContext | undefined>(undefined);
  const scope = useRef(projectId);
  const [notices, setNotices] = useState<TicketNotice[]>([]);

  useEffect(() => {
    const unlock = () => {
      try {
        const context = audio.current ?? new AudioContext();
        audio.current = context;
        void context.resume().catch(() => undefined);
      } catch { /* Browsers without Web Audio still display the alerts. */ }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      void audio.current?.close().catch(() => undefined);
      audio.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (scope.current !== projectId) {
      scope.current = projectId;
      known.current.clear();
      setNotices([]);
    }
    const additions: TicketNotice[] = [];
    let nextSoundAt = audio.current?.currentTime ?? 0;
    for (const job of jobs.filter(item => item.projectId === projectId)) {
      const previous = known.current.get(job.id);
      if (previous && previous !== job.status && job.status in signals) {
        const status = job.status as NoticeStatus;
        const signal = signals[status];
        additions.push({ id: `${job.id}-${status}-${Date.now()}`, status, title: signal.title, description: job.tasks[0]?.description ?? "Ticket" });
        try {
          const context = audio.current;
          if (context?.state === "running") {
            const start = Math.max(context.currentTime, nextSoundAt);
            signal.notes.forEach((frequency, index) => {
              const at = start + index * (signal.duration + 0.07);
              const oscillator = context.createOscillator();
              const gain = context.createGain();
              oscillator.type = "triangle";
              oscillator.frequency.value = frequency;
              gain.gain.setValueAtTime(0, at);
              gain.gain.linearRampToValueAtTime(0.4, at + 0.015);
              gain.gain.exponentialRampToValueAtTime(0.001, at + signal.duration);
              oscillator.connect(gain).connect(context.destination);
              oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
              oscillator.start(at);
              oscillator.stop(at + signal.duration);
            });
            nextSoundAt = start + signal.notes.length * (signal.duration + 0.07);
          }
        } catch { /* Visual alerts remain available when audio is unavailable. */ }
      }
      known.current.set(job.id, job.status);
    }
    if (additions.length) setNotices(current => [...current, ...additions].slice(-5));
  }, [jobs, projectId]);

  useEffect(() => {
    if (!notices.length) return;
    const timer = window.setTimeout(() => setNotices(current => current.slice(1)), 10000);
    return () => window.clearTimeout(timer);
  }, [notices]);

  return { notices, dismissNotice: (id: string) => setNotices(current => current.filter(notice => notice.id !== id)) };
}
