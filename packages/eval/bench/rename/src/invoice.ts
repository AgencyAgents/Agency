import { fmtDate } from "./date.ts";

export interface Invoice {
  id: string;
  issued: Date;
  due: Date;
}

export const invoiceHeader = (invoice: Invoice): string =>
  `Invoice ${invoice.id}, issued ${fmtDate(invoice.issued)}, due ${fmtDate(invoice.due)}`;
