import { fmtDate } from "./date.ts";

export const reportLine = (title: string, at: Date): string => `${fmtDate(at)} ${title}`;
