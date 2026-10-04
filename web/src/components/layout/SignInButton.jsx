import { ArrowUpRight, EnvelopeSimple } from "@phosphor-icons/react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../context/AuthContext";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

/** Google sign-in when configured; otherwise the local-only email sign-in (DEV_LOGIN=true). */
export function SignInButton({ size = "lg", variant = "primary", children }) {
  const { user, methods, signIn, devSignIn } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const island = size === "lg" ? ArrowUpRight : undefined;

  if (user) return <Button to="/app" variant="primary" size={size} icon={island}>Open your library</Button>;

  const start = () => {
    if (methods.google) {
      setBusy(true);
      signIn();
    } else if (methods.devLogin) setOpen(true);
    else setError("No sign-in method is configured. Set GOOGLE_CLIENT_ID/SECRET or DEV_LOGIN=true in .env.");
  };

  return (
    <>
      <Button variant={variant} size={size} icon={island} loading={busy} onClick={start}>
        {children || (methods.google || !methods.devLogin ? "Continue with Google" : "Sign in")}
      </Button>
      {error && !open && <p className="mt-3 max-w-sm text-sm text-warn" role="alert">{error}</p>}
      <Modal open={open} onClose={() => setOpen(false)} title="Local sign-in" size="sm">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await devSignIn(email);
              setOpen(false);
              navigate("/app");
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-mist">Dev mode is on, so no password is needed. Don&apos;t enable this on a shared server.</p>
          <label className="block">
            <span className="sr-only">Email</span>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="field" autoComplete="email" />
          </label>
          {error && <p className="text-sm text-bad" role="alert">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" leading={EnvelopeSimple} loading={busy}>
            Continue
          </Button>
        </form>
      </Modal>
    </>
  );
}
