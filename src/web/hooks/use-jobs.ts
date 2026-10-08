import { useCallback, useEffect, useRef, useState } from "react";
import type { Job } from "../lib/types.js";

/** Polls lightweight ticket snapshots without overlapping requests or rendering unchanged data. */
export function useJobs(projectId?: string, detailId?: string) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const snapshot = useRef("");
  const pending = useRef<Promise<void> | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const query = new URLSearchParams({ view: "summary" });
  if (projectId) query.set("projectId", projectId);
  if (detailId) query.set("detailId", detailId);
  const path = `/api/jobs?${query}`;
  const refresh = useCallback((): Promise<void> => {
    if (pending.current) return pending.current;
    const requestController = new AbortController();
    controller.current = requestController;
    const request = (async () => {
      const response = await fetch(path, { signal: requestController.signal });
      const text = await response.text();
      if (requestController.signal.aborted) return;
      if (!response.ok) throw new Error((JSON.parse(text) as { error?: string }).error ?? "Could not load tickets");
      if (text !== snapshot.current) {
        const next = JSON.parse(text) as Job[];
        snapshot.current = text;
        setJobs(next);
      }
      setError("");
    })().catch(reason => {
      if (requestController.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }).finally(() => { if (controller.current === requestController) pending.current = undefined; });
    pending.current = request;
    return request;
  }, [path]);

  useEffect(() => {
    snapshot.current = "";
    setJobs([]);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh().catch(() => undefined);
      if (!stopped) timer = setTimeout(() => void poll(), document.hidden ? 3_000 : 900);
    };
    const visible = () => { if (!document.hidden) void refresh().catch(() => undefined); };
    void poll();
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      controller.current?.abort();
      pending.current = undefined;
    };
  }, [refresh]);
  return { jobs, refresh, error };
}
