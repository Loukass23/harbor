import { useCallback, useEffect, useRef, useState } from "react";
import { currentAuthor, subscribeAuthor } from "@/lib/theme-auth";
import { acceptFriend, declineFriend, fetchPendingRequests, type PendingRequest } from "./friends";
import { fetchAllNotifications, markAllNotificationsRead, type CenterNotif } from "./notifications";
import { dismissNotifs, isDismissed, subscribeDismissed } from "./dismissed-notifications";
import { setUnreadCount } from "./unread-bridge";

const POLL_MS = 60000;

export function useNotificationCenter() {
  const [authed, setAuthed] = useState(() => !!currentAuthor());
  const [items, setItems] = useState<CenterNotif[]>([]);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const acRef = useRef<AbortController | null>(null);

  const [, setDismTick] = useState(0);

  useEffect(() => subscribeAuthor(() => setAuthed(!!currentAuthor())), []);
  useEffect(() => subscribeDismissed(() => setDismTick((t) => t + 1)), []);

  const refresh = useCallback(async () => {
    if (!currentAuthor()) {
      setItems([]);
      setPending([]);
      setUnread(0);
      return;
    }
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setLoading(true);
    try {
      const [feed, reqs] = await Promise.all([
        fetchAllNotifications(ac.signal),
        fetchPendingRequests(ac.signal).catch(() => [] as PendingRequest[]),
      ]);
      if (ac.signal.aborted) return;
      setItems(feed.items);
      setUnread(feed.unread);
      setPending(reqs);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authed) {
      setItems([]);
      setPending([]);
      setUnread(0);
      return;
    }
    void refresh();
    const id = window.setInterval(() => {
      if (document.hidden) return;
      void refresh();
    }, POLL_MS);
    const onVis = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [authed, refresh]);

  const markRead = useCallback(async () => {
    if (!unread) return;
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnread(0);
    await markAllNotificationsRead();
  }, [unread]);

  const accept = useCallback(
    async (edgeId: string) => {
      setPending((prev) => prev.filter((p) => p.edgeId !== edgeId));
      await acceptFriend(edgeId).catch(() => {});
      void refresh();
    },
    [refresh],
  );

  const decline = useCallback(
    async (edgeId: string) => {
      setPending((prev) => prev.filter((p) => p.edgeId !== edgeId));
      await declineFriend(edgeId).catch(() => {});
      void refresh();
    },
    [refresh],
  );

  const dismiss = useCallback((id: string) => dismissNotifs([id]), []);

  const clearAll = useCallback(async () => {
    dismissNotifs(items.map((n) => n.id));
    await markRead();
  }, [items, markRead]);

  const visibleItems = items.filter((n) => !isDismissed(n.id) && n.kind !== "friend-request");
  const unreadCount = visibleItems.filter((n) => !n.read).length;
  const badge = unreadCount + pending.length;

  useEffect(() => setUnreadCount(badge), [badge]);

  return {
    authed,
    items: visibleItems,
    pending,
    unread: unreadCount,
    badge,
    loading,
    refresh,
    markRead,
    accept,
    decline,
    dismiss,
    clearAll,
  };
}
