import { useEffect, useState } from "react";

import { errorMessage, getSession, getStatus, logout, onUnauthorized } from "./api";
import { Activity } from "./components/activity";
import { Labels } from "./components/labels";
import { Login } from "./components/login";
import { MessageDetail } from "./components/message-detail";
import { MessageList } from "./components/message-list";
import { Overview } from "./components/overview";
import { ErrorText, StateBadge } from "./components/ui";
import { useResource } from "./hooks";
import type { Resource } from "./hooks";
import { useHashRoute } from "./router";
import type { Route } from "./router";
import type { StatusResponse } from "./types";

const NAV = [
  { icon: "desk", label: "Review desk", path: "/" },
  { icon: "messages", label: "Messages", path: "/messages" },
  { icon: "activity", label: "Activity", path: "/activity" },
  { icon: "labels", label: "Labels", path: "/labels" },
];

const TITLES: Record<Route["name"], string> = {
  activity: "Operations log",
  labels: "Label registry",
  message: "Message record",
  messages: "Message index",
  overview: "Review desk",
};

const activePath = (route: Route): string => {
  if (route.name === "message" || route.name === "messages") {
    return "/messages";
  }
  if (route.name === "activity") {
    return "/activity";
  }
  if (route.name === "labels") {
    return "/labels";
  }
  return "/";
};

const NavGlyph = ({ kind }: { kind: string }) => {
  if (kind === "messages") {
    return (
      <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 20 20">
        <path d="M3.5 4.5h13v9h-8l-3.5 2v-2h-1.5z" />
        <path d="M6.5 8h7M6.5 10.5h4" />
      </svg>
    );
  }
  if (kind === "activity") {
    return (
      <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 20 20">
        <path d="M3.5 15.5V10M8 15.5V6.5M12.5 15.5V8.5M17 15.5V3.5" />
      </svg>
    );
  }
  if (kind === "labels") {
    return (
      <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 20 20">
        <path d="M3.5 5.5h7l6 4.5-6 4.5h-7z" />
        <circle cx="7" cy="10" r="1" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 20 20">
      <path d="M3.5 15.5V5.5h13v10zM3.5 8.5h13M7 5.5v3M10 5.5v3M13 5.5v3" />
      <path d="M7 11h6M7 13h3" />
    </svg>
  );
};

const Sidebar = ({
  mode,
  email,
  onSignOut,
  route,
  signOutError,
}: {
  email: string | null;
  mode: string | null;
  onSignOut: () => Promise<void>;
  route: Route;
  signOutError: string | null;
}) => (
  <aside className="sidebar">
    <div className="brand-block">
      <h1>Badi</h1>
      <p>Mailbox classification ledger</p>
    </div>
    <nav>
      {NAV.map((item) => (
        <a
          className={activePath(route) === item.path ? "active" : ""}
          href={`#${item.path}`}
          key={item.path}
          aria-current={activePath(route) === item.path ? "page" : undefined}
        >
          <NavGlyph kind={item.icon} />
          <span>{item.label}</span>
        </a>
      ))}
    </nav>
    <footer className="account-block">
      <div className="account-status">
        <span className="small muted">Processing mode</span>
        <StateBadge state={mode ?? "unknown"} />
      </div>
      <div className="account-actions">
        <p className="small account-email">{email ?? "No mailbox configured"}</p>
        <button
          className="link"
          onClick={async () => {
            await onSignOut();
          }}
          type="button"
        >
          Sign out
        </button>
      </div>
      {signOutError && <p className="small error-text">{signOutError}</p>}
    </footer>
  </aside>
);

const RouteView = ({
  mode,
  route,
  status,
}: {
  mode: string | null;
  route: Route;
  status: Resource<StatusResponse>;
}) => {
  if (route.name === "messages") {
    return <MessageList />;
  }
  if (route.name === "message") {
    return <MessageDetail messageId={route.messageId} mode={mode} />;
  }
  if (route.name === "activity") {
    return <Activity />;
  }
  if (route.name === "labels") {
    return <Labels mode={mode} />;
  }
  return <Overview status={status} />;
};

export const App = () => {
  const session = useResource(getSession);
  const route = useHashRoute();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const authenticated = session.data?.authenticated ?? false;
  const status = useResource(getStatus, {
    enabled: authenticated,
    intervalMs: 20_000,
  });

  useEffect(
    () =>
      onUnauthorized(() => {
        session.refresh();
      }),
    [session.refresh]
  );

  if (session.loading && !session.data) {
    return (
      <div className="login login-loading">
        <div className="loading-sheet" role="status">
          Opening your ledger…
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <Login
        onSuccess={() => {
          session.refresh();
          status.refresh();
        }}
      />
    );
  }

  return (
    <div className="app">
      <Sidebar
        email={status.data?.mailbox?.email ?? null}
        mode={status.data?.mode ?? null}
        onSignOut={async () => {
          setSignOutError(null);
          try {
            await logout();
          } catch (error) {
            setSignOutError(errorMessage(error));
          } finally {
            session.refresh();
          }
        }}
        route={route}
        signOutError={signOutError}
      />

      <main className="main">
        <div className="topbar">
          <h2>{TITLES[route.name]}</h2>
          <div className="row">
            <span className="sync-readout muted small">
              <span className="sync-dot" aria-hidden="true" />
              {status.data
                ? `updated ${new Date(status.data.updatedAt).toLocaleTimeString()}`
                : "status unavailable"}
            </span>
            <button
              onClick={() => {
                status.refresh();
              }}
              type="button"
            >
              Refresh
            </button>
          </div>
        </div>

        {status.error && <ErrorText>Status error: {status.error}</ErrorText>}

        <RouteView mode={status.data?.mode ?? null} route={route} status={status} />
      </main>
    </div>
  );
};
