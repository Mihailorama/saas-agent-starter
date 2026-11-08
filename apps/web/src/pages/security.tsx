import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { KeyRound, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { track } from '@/lib/analytics';
import { client, formatDate, ok } from '@/lib/api';
import { authClient } from '@/lib/auth';

type AuthError = { code?: string; message?: string } | null;
/** Message the API sends while the org requires 2FA and the user has none (tenant.ts). */
export const TWO_FACTOR_REQUIRED = 'two-factor authentication required';
export const policyQuery = {
  queryKey: ['security-policy'],
  queryFn: () => ok(client.GET('/api/security/policy')),
  retry: false,
};

/** Sensitive changes need a sign-in from the last minutes; a stale session gets this code. */
function useReauth() {
  const navigate = useNavigate();
  const [stale, setStale] = useState(false);
  const check = (error: AuthError) => {
    if (error?.code !== 'SESSION_NOT_FRESH') return false;
    setStale(true);
    return true;
  };
  const banner = stale && (
    <Alert>
      <AlertTitle>Confirm it is you</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        This change needs a recent sign-in. Sign in again, then repeat it.
        <Button
          size="sm"
          onClick={async () => {
            await authClient.signOut();
            navigate({ to: '/sign-in', search: { redirect: '/settings/security' } });
          }}
        >
          Sign in again
        </Button>
      </AlertDescription>
    </Alert>
  );
  return { check, banner };
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Save these somewhere safe. Each code signs you in once if you lose your authenticator. They
        are shown only now.
      </p>
      <ul aria-label="Backup codes" className="grid grid-cols-2 gap-2 rounded-md border p-3">
        {codes.map((c) => (
          <li key={c} className="font-mono text-sm">
            {c}
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          navigator.clipboard.writeText(codes.join('\n')).then(() => toast.success('Copied'))
        }
      >
        Copy codes
      </Button>
    </div>
  );
}

/** Password field for re-confirming identity: only accounts from before passwordless sign-in
 * (ADR 0029) still have a password to ask. */
function PasswordField({ hasPassword }: { hasPassword: boolean }) {
  if (!hasPassword) return null;
  return (
    <div className="space-y-2">
      <Label htmlFor="confirm-password">Password</Label>
      <Input
        id="confirm-password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        autoFocus
      />
    </div>
  );
}

const password = (e: FormEvent<HTMLFormElement>) => {
  const p = new FormData(e.currentTarget).get('password');
  return p ? String(p) : undefined;
};

function StepDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function EnrolDialog({
  open,
  onOpenChange,
  hasPassword,
  onReauth,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  hasPassword: boolean;
  onReauth: (e: AuthError) => boolean;
}) {
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] }>();
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const secret = setup && new URL(setup.totpURI).searchParams.get('secret');

  function close(o: boolean) {
    onOpenChange(o);
    if (!o) {
      setSetup(undefined);
      setDone(false);
      setError(undefined);
    }
  }

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const { data, error } = await authClient.twoFactor.enable({ password: password(e) ?? '' });
    setPending(false);
    if (onReauth(error)) return close(false);
    if (error || !data || !('totpURI' in data) || !data.totpURI) {
      return setError(error?.message ?? 'Could not start setup');
    }
    setSetup({ totpURI: data.totpURI, backupCodes: data.backupCodes ?? [] });
  }

  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code')).replace(/\s/g, '');
    setPending(true);
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) return setError(error.message ?? 'That code did not work');
    track('two_factor_enabled');
    await queryClient.invalidateQueries({ queryKey: policyQuery.queryKey });
    setDone(true);
  }

  const errorText = error && (
    <p id="enrol-error" role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );
  return (
    <StepDialog
      open={open}
      onOpenChange={close}
      title={done ? 'Two-factor authentication is on' : 'Set up two-factor authentication'}
      description={
        done
          ? 'From now on, sign-in asks for a code from your authenticator app.'
          : setup
            ? 'Scan the QR code with an authenticator app, then enter the 6-digit code it shows.'
            : 'Use an authenticator app such as 1Password, Google Authenticator or Authy.'
      }
    >
      {done && setup ? (
        <div className="space-y-4">
          <BackupCodes codes={setup.backupCodes} />
          <DialogFooter>
            <Button onClick={() => close(false)}>Done</Button>
          </DialogFooter>
        </div>
      ) : setup ? (
        <form onSubmit={verify} className="space-y-4" aria-label="Verify authenticator">
          <div className="flex justify-center rounded-md border bg-white p-4">
            <QRCodeSVG
              value={setup.totpURI}
              size={176}
              title="QR code for your authenticator app"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Cannot scan it? Enter this key:{' '}
            <code data-testid="totp-secret" className="break-all font-mono text-foreground">
              {secret}
            </code>
          </p>
          <div className="space-y-2">
            <Label htmlFor="enrol-code">Code from the app</Label>
            <Input
              id="enrol-code"
              name="code"
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'enrol-error' : undefined}
            />
            {errorText}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              Turn on
            </Button>
          </DialogFooter>
        </form>
      ) : (
        <form onSubmit={start} className="space-y-4" aria-label="Confirm it is you">
          <PasswordField hasPassword={hasPassword} />
          {errorText}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      )}
    </StepDialog>
  );
}

function TwoFactorCard({
  enabled,
  hasPassword,
  onReauth,
}: {
  enabled: boolean;
  hasPassword: boolean;
  onReauth: (e: AuthError) => boolean;
}) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'enrol' | 'disable' | 'codes'>();
  const [codes, setCodes] = useState<string[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => {
    setDialog(undefined);
    setCodes(undefined);
    setError(undefined);
  };

  async function disable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const { error } = await authClient.twoFactor.disable({ password: password(e) ?? '' });
    setPending(false);
    if (onReauth(error)) return close();
    if (error) return setError(error.message ?? 'Could not turn it off');
    track('two_factor_disabled');
    await queryClient.invalidateQueries({ queryKey: policyQuery.queryKey });
    toast.success('Two-factor authentication is off');
    close();
  }

  async function regenerate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const { data, error } = await authClient.twoFactor.generateBackupCodes({
      password: password(e) ?? '',
    });
    setPending(false);
    if (onReauth(error)) return close();
    if (error || !data) return setError(error?.message ?? 'Could not create new codes');
    setCodes(data.backupCodes);
  }

  const errorText = error && (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" aria-hidden /> Two-factor authentication
          </CardTitle>
          <Badge variant={enabled ? 'default' : 'outline'}>{enabled ? 'On' : 'Off'}</Badge>
        </div>
        <CardDescription>
          Sign-in with an email code also asks for a code from your authenticator app.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {enabled ? (
          <>
            <Button variant="outline" onClick={() => setDialog('codes')}>
              New backup codes
            </Button>
            <Button variant="outline" onClick={() => setDialog('disable')}>
              Turn off
            </Button>
          </>
        ) : (
          <Button onClick={() => setDialog('enrol')}>Set up two-factor</Button>
        )}
      </CardContent>
      <EnrolDialog
        open={dialog === 'enrol'}
        onOpenChange={(o) => !o && close()}
        hasPassword={hasPassword}
        onReauth={onReauth}
      />
      <StepDialog
        open={dialog === 'disable'}
        onOpenChange={(o) => !o && close()}
        title="Turn off two-factor authentication?"
        description="Your account will be protected by email codes only. If your organization requires two-factor, you lose access until you set it up again."
      >
        <form onSubmit={disable} className="space-y-4" aria-label="Turn off two-factor">
          <PasswordField hasPassword={hasPassword} />
          {errorText}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              Turn off
            </Button>
          </DialogFooter>
        </form>
      </StepDialog>
      <StepDialog
        open={dialog === 'codes'}
        onOpenChange={(o) => !o && close()}
        title="New backup codes"
        description="Your old backup codes stop working."
      >
        {codes ? (
          <div className="space-y-4">
            <BackupCodes codes={codes} />
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={regenerate} className="space-y-4" aria-label="New backup codes">
            <PasswordField hasPassword={hasPassword} />
            {errorText}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                Create new codes
              </Button>
            </DialogFooter>
          </form>
        )}
      </StepDialog>
    </Card>
  );
}

type Passkey = { id: string; name?: string | null; createdAt: string | Date };

function PasskeysCard({ onReauth }: { onReauth: (e: AuthError) => boolean }) {
  const { data: passkeys, isPending, refetch } = authClient.useListPasskeys();
  const [renaming, setRenaming] = useState<Passkey>();
  const [deleting, setDeleting] = useState<Passkey>();
  const [pending, setPending] = useState(false);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get('name')).trim() || undefined;
    setPending(true);
    const { error } = await authClient.passkey.addPasskey({ name });
    setPending(false);
    if (onReauth(error)) return;
    if (error) return toast.error(error.message ?? 'Could not add the passkey');
    track('passkey_added');
    form.reset();
    toast.success('Passkey added');
  }

  async function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name')).trim();
    const { error } = await authClient.$fetch('/passkey/update-passkey', {
      method: 'POST',
      body: { id: renaming?.id, name },
    });
    if (error) return toast.error(error.message ?? 'Could not rename');
    setRenaming(undefined);
    refetch();
  }

  async function remove() {
    const { error } = await authClient.$fetch<{ status: boolean }>('/passkey/delete-passkey', {
      method: 'POST',
      body: { id: deleting?.id },
    });
    setDeleting(undefined);
    if (onReauth(error as AuthError)) return;
    if (error) return toast.error(error.message ?? 'Could not delete');
    toast.success('Passkey deleted');
    refetch();
  }

  const label = (p: Passkey) => p.name || 'Passkey';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" aria-hidden /> Passkeys
        </CardTitle>
        <CardDescription>
          Sign in with your fingerprint, face, screen lock or a security key instead of an email
          code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : passkeys?.length ? (
          <ul aria-label="Your passkeys" className="divide-y rounded-md border">
            {passkeys.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{label(p)}</span>
                  <span className="block text-xs text-muted-foreground">
                    Added {formatDate(new Date(p.createdAt).toISOString())}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Rename ${label(p)}`}
                  onClick={() => setRenaming(p)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${label(p)}`}
                  onClick={() => setDeleting(p)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No passkeys yet.</p>
        )}
        <form onSubmit={add} className="flex flex-wrap items-end gap-2" aria-label="Add passkey">
          <div className="min-w-48 flex-1 space-y-2">
            <Label htmlFor="passkey-name">Name (optional)</Label>
            <Input id="passkey-name" name="name" maxLength={64} placeholder="Work laptop" />
          </div>
          <Button type="submit" variant="outline" disabled={pending}>
            Add passkey
          </Button>
        </form>
      </CardContent>
      <StepDialog
        open={Boolean(renaming)}
        onOpenChange={(o) => !o && setRenaming(undefined)}
        title="Rename passkey"
        description="Pick a name that tells you which device it is on."
      >
        <form onSubmit={rename} className="space-y-4" aria-label="Rename passkey">
          <div className="space-y-2">
            <Label htmlFor="passkey-rename">Name</Label>
            <Input
              id="passkey-rename"
              name="name"
              defaultValue={renaming?.name ?? ''}
              maxLength={64}
              required
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenaming(undefined)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </StepDialog>
      <StepDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`Delete ${deleting ? label(deleting) : 'passkey'}?`}
        description="You can no longer sign in with it. The credential may stay on the device; remove it there too."
      >
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleting(undefined)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={remove}>
            Delete
          </Button>
        </DialogFooter>
      </StepDialog>
    </Card>
  );
}

function OrgPolicyCard({ twoFactor }: { twoFactor: boolean }) {
  const queryClient = useQueryClient();
  const policy = useQuery(policyQuery);
  const save = useMutation({
    mutationFn: (json: { requireTwoFactor: boolean }) =>
      ok(client.PUT('/api/security/policy', { body: json })),
    onSuccess: (data) => {
      queryClient.setQueryData(policyQuery.queryKey, data);
      toast.success(data.requireTwoFactor ? 'Two-factor is now required' : 'Requirement removed');
    },
    onError: (err) => toast.error(err.message),
  });
  const required = policy.data?.requireTwoFactor ?? false;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Organization policy</CardTitle>
        <CardDescription>
          Members without two-factor are sent to set it up after signing in and cannot open
          organization data until they do. A passkey alone does not count: they need an
          authenticator app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-start gap-2">
          <input
            id="require-2fa"
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={required}
            disabled={policy.isPending || save.isPending || (!twoFactor && !required)}
            aria-describedby={!twoFactor ? 'require-2fa-hint' : undefined}
            onChange={(e) => save.mutate({ requireTwoFactor: e.target.checked })}
          />
          <Label htmlFor="require-2fa" className="font-normal leading-snug">
            Require two-factor authentication for all members
          </Label>
        </div>
        {!twoFactor && (
          <p id="require-2fa-hint" className="text-sm text-muted-foreground">
            Set up two-factor for your own account first.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function SecurityPage() {
  const { data: session } = authClient.useSession();
  const { data: member } = authClient.useActiveMember();
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => (await authClient.listAccounts()).data ?? [],
  });
  const policy = useQuery(policyQuery);
  const { check, banner } = useReauth();
  const enabled = session?.user.twoFactorEnabled === true;
  const hasPassword = accounts.data?.some((a) => a.providerId === 'credential') ?? true;
  // UI hint only; the API enforces the role.
  const isAdmin = member?.role.split(',').some((r) => r === 'admin' || r === 'owner') ?? false;
  const blocked = policy.error?.message === TWO_FACTOR_REQUIRED && !enabled;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <p className="text-sm text-muted-foreground">
          Two-factor authentication and passkeys for your account.
        </p>
      </div>
      {blocked && (
        <Alert variant="destructive">
          <AlertTitle>Your organization requires two-factor authentication</AlertTitle>
          <AlertDescription>Set it up below to continue to your workspace.</AlertDescription>
        </Alert>
      )}
      {banner}
      <TwoFactorCard enabled={enabled} hasPassword={hasPassword} onReauth={check} />
      <PasskeysCard onReauth={check} />
      {isAdmin && <OrgPolicyCard twoFactor={enabled} />}
    </div>
  );
}
