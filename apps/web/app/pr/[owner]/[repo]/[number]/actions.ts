"use server";

import { revalidatePath } from "next/cache";
import { recordRefute } from "../../../../../lib/findings";

/**
 * Refute a finding's claim (issue #13). Records a 👎 against the chunk
 * fingerprint + tier — the precision signal — then revalidates the card so the
 * UI reflects it. Advisory only: this writes a signal, it never gates merge.
 */
export async function refute(formData: FormData): Promise<void> {
  const owner = String(formData.get("owner") ?? "");
  const repo = String(formData.get("repo") ?? "");
  const prNumber = Number(formData.get("prNumber"));
  const fingerprint = String(formData.get("fingerprint") ?? "");
  const tier = String(formData.get("tier") ?? "");

  if (!owner || !repo || !Number.isInteger(prNumber) || !fingerprint || !tier) {
    return;
  }

  await recordRefute({ owner, repo, prNumber }, fingerprint, tier);
  revalidatePath(`/pr/${owner}/${repo}/${prNumber}`);
}
