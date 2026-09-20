import type { ReactNode } from "react";

export const Card = ({
  children,
  className,
  title,
  actions,
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: ReactNode;
}) => (
  <section className={`card${className ? ` ${className}` : ""}`}>
    {(title || actions) && (
      <header className="card-header">
        {typeof title === "string" ? <h2>{title}</h2> : title}
        {actions && <div className="card-actions">{actions}</div>}
      </header>
    )}
    {children}
  </section>
);

export const Stat = ({
  hint,
  label,
  tone,
  value,
}: {
  hint?: string;
  label: string;
  tone?: "danger" | "ok" | "warn";
  value: ReactNode;
}) => (
  <div className={`stat${tone ? ` stat-${tone}` : ""}`}>
    <span className="stat-label">{label}</span>
    <span className="stat-value">{value}</span>
    {hint && <span className="stat-hint">{hint}</span>}
  </div>
);

export const Badge = ({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "danger" | "muted" | "ok" | "warn";
}) => <span className={`badge${tone ? ` badge-${tone}` : ""}`}>{children}</span>;

export const ErrorText = ({ children }: { children: ReactNode }) =>
  children ? <p className="error-text">{children}</p> : null;

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="empty">{children}</p>
);

const TONE_BY_STATE: Record<string, "danger" | "muted" | "ok" | "warn"> = {
  applied: "ok",
  apply: "danger",
  applying: "warn",
  auth_required: "danger",
  classified: "warn",
  classifying: "warn",
  completed: "ok",
  conflict: "danger",
  corrected: "warn",
  dry_run: "muted",
  error: "danger",
  failed: "danger",
  missing: "muted",
  "needs review": "warn",
  needs_review: "warn",
  no_change: "muted",
  not_applied: "muted",
  not_applied_dry_run: "muted",
  not_ready: "warn",
  paused: "muted",
  pending: "warn",
  pending_mode: "warn",
  queued: "warn",
  ready: "ok",
  retry_wait: "danger",
  running: "warn",
  skipped: "muted",
  unavailable: "muted",
  unknown: "muted",
};

export const StateBadge = ({ state }: { state: string | null | undefined }) => {
  if (!state) {
    return <Badge tone="muted">—</Badge>;
  }
  return (
    <Badge tone={TONE_BY_STATE[state] ?? "muted"}>{state.replaceAll("_", " ")}</Badge>
  );
};

export const ActionBadge = ({
  label,
  value,
}: {
  label: string;
  value: boolean | null;
}) => {
  let tone: "danger" | "muted" | "warn" = "warn";
  let text = "uncertain";
  if (value === true) {
    tone = "danger";
    text = "yes";
  } else if (value === false) {
    tone = "muted";
    text = "no";
  }
  return (
    <Badge tone={tone}>
      {label}: {text}
    </Badge>
  );
};
