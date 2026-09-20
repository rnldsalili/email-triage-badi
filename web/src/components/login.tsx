import { useState } from "react";

import { login } from "../api";
import { ErrorText } from "./ui";

export const Login = ({ onSuccess }: { onSuccess: () => void }) => {
  const [token, setToken] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setFailure(null);
    try {
      await login(token.trim());
      setToken("");
      onSuccess();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Login failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="login">
      <form className="card login-sheet" onSubmit={submit}>
        <div className="login-mark" aria-hidden="true">
          B
        </div>
        <p className="login-kicker">Private mailbox ledger</p>
        <h2>Open Badi</h2>
        <p className="login-intro">
          Review classifications, preserve your manual decisions, and apply only what you
          trust. Your token is exchanged for a short-lived session and is never stored in
          this browser.
        </p>
        <div className="field">
          <label htmlFor="admin-token">Admin API token</label>
          <input
            autoComplete="off"
            autoFocus
            id="admin-token"
            name="admin-token"
            onChange={(event) => setToken(event.target.value)}
            type="password"
            value={token}
          />
        </div>
        <ErrorText>{failure}</ErrorText>
        <div className="login-actions">
          <button
            className="primary"
            disabled={pending || token.trim().length < 8}
            type="submit"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
};
