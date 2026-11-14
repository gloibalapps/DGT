import type { UEJob } from "@/src/ueParse";

/** Jobs scanned on the guarantee week view, waiting to be reviewed on the jobs list. */
export const ueScanStash: { jobs: UEJob[] | null; rejected: number; weekStart: string | null } = {
  jobs: null, rejected: 0, weekStart: null,
};
