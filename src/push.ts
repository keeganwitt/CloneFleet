import { basename } from "./format";
import type { PushPlan } from "./types";

const MAX_LISTED = 10;

export function describePushes(pushes: [path: string, plan: PushPlan][]): string {
  const forced = pushes.filter(([, plan]) => plan.force).length;
  const lines = pushes.slice(0, MAX_LISTED).map(([path, plan]) => {
    const target = `${plan.remote}/${plan.branch}`;
    return plan.force
      ? `• ${basename(path)}: force push to ${target}`
      : `• ${basename(path)}: ${plan.commits} commit${plan.commits === 1 ? "" : "s"} to ${target}`;
  });
  if (pushes.length > MAX_LISTED) lines.push(`• …and ${pushes.length - MAX_LISTED} more`);
  const header = `Push ${pushes.length} ${pushes.length === 1 ? "repository" : "repositories"}?`;
  const warning =
    forced > 0
      ? `\n\n${forced} will be force-pushed with a lease: the push is refused if the fork changed since the rebase.`
      : "";
  return `${header}\n\n${lines.join("\n")}${warning}`;
}
