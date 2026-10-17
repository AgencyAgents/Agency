import { clamp } from "./util.ts";

export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
}

/** Splits `items` into pages of `size`; `page` counts from 1. */
export function paginate<T>(items: T[], page: number, size: number): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = clamp(page, 1, pages);
  const start = current * size;
  return { items: items.slice(start, start + size), page: current, pages };
}
