"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export const UNDO_WINDOW_MS = 5000;

type Decision = "approve" | "reject";
type Pending = { decision: Decision; reason?: string; timer: number };

function send(id: string, decision: Decision, reason?: string, keepalive = false) {
  return fetch(`/api/action-requests/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, reason }),
    keepalive,
  });
}

// Approve and reject take effect in the list at once. The request waits
// for the undo window, so a mistaken click costs nothing.
export function useApprovalDecisions(onSettled: () => void | Promise<void>) {
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const pending = useRef(new Map<string, Pending>());
  const settledRef = useRef(onSettled);

  useEffect(() => {
    settledRef.current = onSettled;
  }, [onSettled]);

  useEffect(() => {
    const queue = pending.current;
    const flush = () => {
      for (const [id, p] of queue) {
        window.clearTimeout(p.timer);
        void send(id, p.decision, p.reason, true);
      }
      queue.clear();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  const setHidden = useCallback((id: string, hidden: boolean) => {
    setHiddenIds((current) => {
      const next = new Set(current);
      if (hidden) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const decide = useCallback(
    (id: string, decision: Decision, label: string, reason?: string) => {
      setHidden(id, true);
      const timer = window.setTimeout(async () => {
        pending.current.delete(id);
        try {
          const res = await send(id, decision, reason);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch {
          toast.error(`OpenNeko could not record the ${decision === "approve" ? "approval" : "rejection"}. Try again.`);
        }
        await settledRef.current();
        setHidden(id, false);
      }, UNDO_WINDOW_MS);
      pending.current.set(id, { decision, reason, timer });
      toast(decision === "approve" ? "Approved" : "Rejected", {
        description: label,
        duration: UNDO_WINDOW_MS,
        action: {
          label: "Undo",
          onClick: () => {
            const p = pending.current.get(id);
            if (!p) return;
            window.clearTimeout(p.timer);
            pending.current.delete(id);
            setHidden(id, false);
          },
        },
      });
    },
    [setHidden],
  );

  const approve = useCallback((id: string, label: string) => decide(id, "approve", label), [decide]);

  const beginReject = useCallback((id: string) => {
    setRejectingId(id);
    setRejectReason("");
  }, []);

  const cancelReject = useCallback(() => {
    setRejectingId(null);
    setRejectReason("");
  }, []);

  const submitReject = useCallback(
    (label: string) => {
      if (!rejectingId) return;
      const reason = rejectReason.trim() || undefined;
      const id = rejectingId;
      setRejectingId(null);
      setRejectReason("");
      decide(id, "reject", label, reason);
    },
    [decide, rejectReason, rejectingId],
  );

  return {
    hiddenIds,
    rejectingId,
    rejectReason,
    setRejectReason,
    approve,
    beginReject,
    cancelReject,
    submitReject,
  };
}
