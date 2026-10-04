import { CheckCircle, LinkBreak, Plugs, SignOut, WarningCircle } from "@phosphor-icons/react";
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { providerMeta } from "../../components/ui/Brand";
import { Bezel } from "../../components/ui/Bezel";
import { Button } from "../../components/ui/Button";
import { ErrorState, Meter, Skeleton } from "../../components/ui/Feedback";
import { PipelineStatus } from "../../components/ui/PipelineStatus";
import { Capabilities } from "../../components/ui/Capabilities";
import { RevealGroup, RevealItem } from "../../components/ui/Reveal";
import { useAuth } from "../../context/AuthContext";
import { useConnectProvider, useDisconnectProvider, useProviders, useStorage } from "../../hooks/queries";
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
              {provider.key === "local" ? (
                <><CheckCircle size={12} weight="fill" /> Always available on this machine</>
              ) : provider.connected ? (
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
        {provider.key === "local" ? (
          <p className="text-xs text-haze">Files are kept in the server&apos;s <code className="font-mono">library</code> volume.</p>
        ) : provider.connected ? (
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
            onClick={() => connect.mutate(provider.key, { onError: (e) => toast(e.message, { tone: "error" }) })}
          >
            Connect {meta.label}
          </Button>
        )}
      </div>
    </Bezel>
  );
}

export default function Settings() {
  const { user, signOut } = useAuth();
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
          <Button variant="ghost" leading={SignOut} onClick={signOut}>Sign out</Button>
        </Bezel>
      </section>
    </>
  );
}
