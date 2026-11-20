import type { DupeLevel } from "@/src/receiptDupe";

export interface PendingReceipt {
  image: string;
  sha256: string;
  dhash: string;
  ahash: string;
  dhashRots: string[];
  ahashRots: string[];
  amount: string;
  date: string;
  merchant: string;
  category: string;
  liters: string;
  gst: string;
  txnTime: string;
  receiptNumber: string;
  abn: string;
  cardLast4: string;
  pump: string;
  level: DupeLevel;
  scanSkipped: boolean;
}

export const receiptStash: {
  image: string | null;
  batch: PendingReceipt[];
  index: number;
} = { image: null, batch: [], index: 0 };
