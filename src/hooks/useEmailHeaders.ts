import { useEffect, useRef, useState } from "react";
import { invoke } from "../busy";
import type { EmailHeader } from "../types";

/// Header fields of the given mail files, keyed by path: absent while still
/// being read, `null` for a mail that can't be parsed. A path that leaves the
/// list is read again when it returns, as the file may have changed meanwhile.
export function useEmailHeaders(paths: string[]): Record<string, EmailHeader | null | undefined> {
  const [headers, setHeaders] = useState<Record<string, EmailHeader | null>>({});
  const requested = useRef(new Set<string>());
  // Keyed by content: callers build the array afresh on every render.
  const key = JSON.stringify(paths);
  useEffect(() => {
    const wanted = JSON.parse(key) as string[];
    const live = new Set(wanted);
    requested.current.forEach((p) => {
      if (!live.has(p)) requested.current.delete(p);
    });
    const fresh = wanted.filter((p) => !requested.current.has(p));
    if (fresh.length === 0) return;
    fresh.forEach((p) => requested.current.add(p));
    const store = (found: Record<string, EmailHeader>) =>
      setHeaders((prev) => ({ ...prev, ...Object.fromEntries(fresh.map((p) => [p, found[p] ?? null])) }));
    invoke<Record<string, EmailHeader>>("get_email_headers", { paths: fresh })
      .then(store)
      .catch(() => store({}));
  }, [key]);
  return headers;
}
