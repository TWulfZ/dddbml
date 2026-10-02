import { useEffect } from 'preact/hooks';
import { memo } from 'preact/compat';
import { store, useAppStore } from '../state/store';

const NOTICE_MS = 3500;

/** Transient canvas notice: why a canvas action did nothing (spec 13 F89, spec 19 focus). */
function NoticeImpl() {
  const notice = useAppStore((s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => store.getState().clearNotice(notice.seq), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice) return null;
  return (
    <div class="ddd-notice" role="status" aria-live="polite">
      {notice.text}
    </div>
  );
}

// memo: App re-renders on many store slices; this only re-renders via its own subscription.
export const Notice = memo(NoticeImpl);
