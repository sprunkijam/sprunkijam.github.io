/** Join a public/ path to Vite BASE_URL ("/" on Pages, "./" on itch). */
export function publicUrl(path: string): string {
  const cleaned = path.replace(/^\/+/, "");
  const base = import.meta.env.BASE_URL || "/";
  if (base === "/") return `/${cleaned}`;
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}${cleaned}`;
}

/** Absolute-looking /art/... that still respects BASE_URL. */
export function artUrl(path: string): string {
  const cleaned = path.replace(/^\/?(art\/)?/, "");
  return publicUrl(`art/${cleaned}`);
}
