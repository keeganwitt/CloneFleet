import type { CommandRecord } from "../types";

export function CommandLog({ commands }: { commands: CommandRecord[] }) {
  if (commands.length === 0) return <p className="muted">No git commands ran.</p>;
  return (
    <ol className="command-log">
      {commands.map((command, index) => (
        <li key={index} className={command.exitCode === 0 ? "" : "command-failed"}>
          <code>git {command.args.join(" ")}</code>
          <span className="exit-code">exit {command.exitCode ?? "signal"}</span>
          {command.stdout.trim() && <pre>{command.stdout.trim()}</pre>}
          {command.stderr.trim() && <pre className="stderr">{command.stderr.trim()}</pre>}
        </li>
      ))}
    </ol>
  );
}
