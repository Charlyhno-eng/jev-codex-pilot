import { useEffect } from "react";
import logoUrl from "../../../assets/jev-codex-pilot-logo2.png";
import { api } from "../lib/api.js";
import type { Job } from "../lib/types.js";

type TicketState = "RUNNING" | "SUCCESS" | "FAILED";

const STATE_COLORS: Record<TicketState, string> = {
  RUNNING: "#5c9dff",
  SUCCESS: "#70dcff",
  FAILED: "#ff718c"
};

function renderFavicon(states: TicketState[]) {
  const favicon = document.getElementById("app-favicon") as HTMLLinkElement | null;
  if (!favicon) return;
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(image, 0, 0, 64, 64);
    states.forEach((state, index) => {
      const x = 54 - index * 13;
      context.beginPath();
      context.arc(x, 54, 8, 0, Math.PI * 2);
      context.fillStyle = "#080b14";
      context.fill();
      context.beginPath();
      context.arc(x, 54, 5.5, 0, Math.PI * 2);
      context.fillStyle = STATE_COLORS[state];
      context.fill();
    });
    favicon.href = canvas.toDataURL("image/png");
  };
  image.src = logoUrl;
}

export function useBrowserTabIndicator() {
  useEffect(() => {
    let previous = "";
    const update = () => void api<Job[]>("/jobs").then(jobs => {
      const states = (["RUNNING", "SUCCESS", "FAILED"] as TicketState[]).filter(state => jobs.some(job => job.status === state));
      const next = states.join(",");
      if (next === previous) return;
      previous = next;
      renderFavicon(states);
    }).catch(() => undefined);
    update();
    const timer = window.setInterval(update, 1_500);
    return () => window.clearInterval(timer);
  }, []);
}
