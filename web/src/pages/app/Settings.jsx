import { CheckCircle, LinkBreak, Plugs, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { providerMeta } from "../../components/ui/Brand";
import { Bezel } from "../../components/ui/Bezel";
import { Button } from "../../components/ui/Button";
import { ErrorState, Meter, Skeleton } from "../../components/ui/Feedback";
import { PipelineStatus } from "../../components/ui/PipelineStatus";
import { Capabilities } from "../../components/ui/Capabilities";
import { RevealGroup, RevealItem } from "../../components/ui/Reveal";
import { useAuth } from "../../context/AuthContext";
import { useConnectProvider, useConnectWithCredentials, useDisconnectProvider, useProviders, useStorage } from "../../hooks/queries";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../hooks/useToast";
import { formatBytes, formatDate } from "../../lib/format";
import { PageHeader } from "./PageHeader";

const OAUTH_MESSAGES = {
  success: ["Connected. New uploads can go there right away.", "success"],
  denied: ["Connection cancelled.", "info"],
  expired: ["That connection link expired. Please try again.", "error"],
  error: ["The provider rejected the connection. Please try again.", "error"],
};

function ProviderCard({ provider, quota }) {
  const meta = providerMeta[provider.key];
  const connect = useConnectProvider();
  const disconnect = useDisconnectProvider();
  const [askCredentials, setAskCredentials] = useState(false);
  const { toast } = useToast();

  return (
    <Bezel coreClassName="flex flex-col gap-6 p-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.04] ring-1 ring-white/10">
            <meta.Icon size={24} weight="fill" className={meta.tint} />
          </span>
          <div>
            <h3 className="font-medium">{meta.label}</h3>
            <p className={`mt-0.5 flex items-center gap-1.5 text-xs ${provider.connected ? "text-ok" : "text-haze"}`}>
              {provider.connected ? (
                <><CheckCircle size={12} weight="fill" /> Connected</>
              ) : provider.available ? (
                "Not connected"
              ) : (
                "Not configured (add OAuth keys to .env)"
              )}
            </p>
          </div>
        </div>
      </div>

      {provider.connected && quota && !quota.error && (
        <Meter value={quota.total ? quota.used / quota.total : 0} label="Used" sub={`${formatBytes(quota.used)} of ${formatBytes(quota.total)}`} />
      )}
      {quota?.error === "reauth" && (
        <p className="flex items-center gap-2 text-sm text-warn"><WarningCircle size={16} /> Access expired. Reconnect to keep syncing.</p>
      )}

      <div className="mt-auto">
        {provider.connected ? (
          <Button
            variant="quiet"
            size="sm"
            leading={LinkBreak}
            loading={disconnect.isPending}
            onClick={() =>
              window.confirm(`Disconnect ${meta.label}? Files stay in your ${meta.label}, but OmniCloud can no longer show them.`) &&
              disconnect.mutate(provider.key, {
                onSuccess: () => toast(`${meta.label} disconnected and access revoked.`, { tone: "success" }),
                onError: (e) => toast(e.message, { tone: "error" }),
              })
            }
          >
            Disconnect
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            leading={Plugs}
            disabled={!provider.available}
            loading={connect.isPending}
            onClick={() =>
              provider.method === "credentials"
                ? setAskCredentials(true)
                : connect.mutate(provider.key, { onError: (e) => toast(e.message, { tone: "error" }) })
            }
          >
            Connect {meta.label}
          </Button>
        )}
      </div>
      {provider.method === "credentials" && (
        <CredentialsDialog provider={provider} label={meta.label} open={askCredentials} onClose={() => setAskCredentials(false)} />
      )}
    </Bezel>
  );
}

// Koofr: no developer app needed — the user pastes an app password generated in Koofr's settings.
function CredentialsDialog({ provider, label, open, onClose }) {
  const connect = useConnectWithCredentials();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <Modal open={open} onClose={onClose} title={`Connect ${label}`} size="sm">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          connect.mutate(
            { provider: provider.key, email, password },
            {
              onSuccess: () => {
                toast(`${label} connected.`, { tone: "success" });
                setPassword("");
                onClose();
              },
              onError: (err) => toast(err.message, { tone: "error" }),
            }
          );
        }}
      >
        <p className="text-sm text-mist">
          In Koofr open{" "}
          <a className="text-aqua underline" href="https://app.koofr.net/app/admin/preferences/password" target="_blank" rel="noopener noreferrer">
            Preferences → Password → App passwords
          </a>
          , generate one named “OmniCloud”, and paste it here. Your normal Koofr password won&apos;t work.
        </p>
        <input className="field" type="email" required placeholder="Koofr email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        <input className="field" type="password" required placeholder="App password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
        <Button type="submit" variant="primary" className="w-full" loading={connect.isPending}>
          Connect
        </Button>
      </form>
    </Modal>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const providers = useProviders();
  const anyConnected = providers.data?.some((p) => p.connected);
  const storage = useStorage(Boolean(anyConnected));
  const [params, setParams] = useSearchParams();
  const { toast } = useToast();

  // Surface the OAuth round-trip result once, then clean the URL.
  const status = params.get("status");
  useEffect(() => {
    if (!status) return;
    const [msg, tone] = OAUTH_MESSAGES[status] || OAUTH_MESSAGES.error;
    toast(msg, { tone });
    setParams({}, { replace: true });
  }, [status, toast, setParams]);

  return (
    <>
      <PageHeader eyebrow="Settings" title="Connections & account">
        Keep files on this machine, or connect Google Drive and Dropbox. Cloud grants are encrypted and revocable at any time.
      </PageHeader>

      <section aria-labelledby="clouds" className="mb-16">
        <h2 id="clouds" className="mb-5 text-sm uppercase tracking-[0.18em] text-haze">Clouds</h2>
        {providers.isPending ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"><Skeleton className="h-56" /><Skeleton className="h-56" /><Skeleton className="h-56" /></div>
        ) : providers.isError ? (
          <ErrorState error={providers.error} onRetry={() => providers.refetch()} />
        ) : (
          <RevealGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {providers.data.map((p) => (
              <RevealItem key={p.key}>
                <ProviderCard provider={p} quota={storage.data?.providers?.[p.key]} />
              </RevealItem>
            ))}
          </RevealGroup>
        )}
      </section>

      <section aria-labelledby="pipeline" className="mb-16">
        <h2 id="pipeline" className="mb-5 text-sm uppercase tracking-[0.18em] text-haze">Processing</h2>
        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <PipelineStatus />
          <Capabilities />
        </div>
      </section>

      <section aria-labelledby="account">
        <h2 id="account" className="mb-5 text-sm uppercase tracking-[0.18em] text-haze">Account</h2>
        <Bezel className="max-w-2xl" coreClassName="flex flex-col gap-6 p-6 sm:flex-row sm:items-center">
          {user?.avatar && <img src={user.avatar} alt="" referrerPolicy="no-referrer" className="h-16 w-16 rounded-2xl ring-1 ring-white/10" />}
          <div className="min-w-0 flex-1">
            <p className="text-lg font-medium">{user?.name}</p>
            <p className="truncate text-sm text-mist">{user?.email}</p>
            <p className="mt-1 text-xs text-haze">Member since {formatDate(user?.createdAt)}</p>
          </div>
        </Bezel>
      </section>
    </>
  );
}
