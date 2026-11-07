import { createHash } from 'node:crypto';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry/lib/client';
import type { BillingEvent } from './billing/provider.ts';
import { env } from './env.ts';

let client: Promise<Client> | undefined;

export function temporal(): Promise<Client> {
  client ??= Connection.connect({ address: env.TEMPORAL_ADDRESS }).then(
    (connection) =>
      new Client({
        connection,
        namespace: env.TEMPORAL_NAMESPACE,
        interceptors: { workflow: [new OpenTelemetryWorkflowClientInterceptor()] },
      }),
  );
  return client;
}

export async function closeTemporal() {
  if (client) await (await client).connection.close();
}

/** Contract with services/worker-py: workflow type, id and argument shape. */
export type ProjectCreated = {
  orgId: string;
  projectId: string;
  name: string;
  /** User who triggered it; recorded as actor of the AI calls the workflow makes. */
  actorId: string | null;
};
export const projectWorkflowId = (projectId: string) => `project-created-${projectId}`;

/** Starts a workflow at most once per id. Returns false if that id already ran (or runs). */
async function startOnce(type: string, workflowId: string, arg: object): Promise<boolean> {
  try {
    await (await temporal()).workflow.start(type, {
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workflowId,
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      args: [arg],
    });
    return true;
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) return false;
    throw err;
  }
}

/** Idempotent: the workflow id is derived from the project id, duplicates are rejected. */
export async function startProjectCreated(event: ProjectCreated) {
  await startOnce('ProjectCreatedWorkflow', projectWorkflowId(event.projectId), event);
}

/** Service desk (docs/support.md). Ids only: the worker reads message content from Chatwoot. */
export type SupportConversation = { accountId: number; conversationId: number };
export const supportTriageWorkflowId = (c: SupportConversation) =>
  `support-triage-${c.accountId}-${c.conversationId}`;
/** One triage per conversation: the first incoming message starts it, later ones are no-ops. */
export const startSupportTriage = (c: SupportConversation) =>
  startOnce('SupportTriageWorkflow', supportTriageWorkflowId(c), c);

/** A tracker item linked to conversations was closed; `closeId` makes each close event unique. */
export type SupportIssueClosed = {
  tracker: 'github' | 'plane';
  issueId: string;
  /** Release tag from the `Released in vX.Y.Z` comment (GitHub or Plane); empty for a close. */
  release?: string;
  /** Plane user id of the release comment's author; the worker acts only on its own comments. */
  author?: string;
};
export const supportClosedWorkflowId = (e: SupportIssueClosed, closeId: string) =>
  `support-closed-${e.tracker}-${e.issueId}-${closeId}`;
export const startSupportIssueClosed = (e: SupportIssueClosed, closeId: string) =>
  startOnce('SupportIssueClosedWorkflow', supportClosedWorkflowId(e, closeId), e);
/**
 * Contract with services/worker-py (worker/tracker.py): a redacted tracker item whose title and
 * body are the JSON object at `s3Key` (uploads bucket). The worker files it and deletes the object.
 */
export type TrackerItem = { producer: 'cjm-regression' | 'from-users'; s3Key: string };
export const startTrackerItem = (item: TrackerItem, hash: string) =>
  startOnce('TrackerItemWorkflow', `tracker-item-${hash}`, item);
/** Contract with services/worker-py (worker/mail.py): one rendered email to one recipient. */
export type SendEmail = {
  kind: 'verify-email' | 'reset-password' | 'invitation' | 'data-export-ready';
  to: string;
  subject: string;
  html: string;
  text: string;
};
/** `key` identifies one send (token, invitation id + expiry); only its hash is in the id. */
export const emailWorkflowId = (kind: SendEmail['kind'], key: string) =>
  `email-${kind}-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;

/** Delivery and SMTP retries happen in the worker; a duplicate start for the same key is a no-op. */
export async function startSendEmail(email: SendEmail, key: string) {
  try {
    await (await temporal()).workflow.start('SendEmailWorkflow', {
      taskQueue: env.EMAIL_TASK_QUEUE,
      workflowId: emailWorkflowId(email.kind, key),
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      args: [email],
    });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }
}

/**
 * Applies one normalized billing event in the worker (BillingEventWorkflow). The workflow id is
 * the provider's event id, so a webhook delivered twice is applied once; the activity is also
 * idempotent (docs/billing.md). Throws if Temporal is unreachable: the webhook then answers 5xx
 * and the provider redelivers it.
 */
export const billingWorkflowId = (e: { provider: string; eventId: string }) =>
  `billing-${e.provider}-${e.eventId}`;
export async function startBillingEvent(event: BillingEvent) {
  try {
    await (await temporal()).workflow.start('BillingEventWorkflow', {
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workflowId: billingWorkflowId(event),
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      args: [event],
    });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }
}

/** Contract with services/worker-py (worker/webhooks.py): ids only, the payload stays in the DB. */
export type WebhookEvent = {
  orgId: string;
  eventId: string;
  deliveryIds: string[];
  /** Replay: send even if the delivery already succeeded. */
  replay?: boolean;
};

/**
 * Delivers one event to its endpoints (retries with backoff in the worker). `workflowId` is
 * `webhook-event-<eventId>` for the first delivery (duplicates rejected) and unique per replay.
 */
export async function startWebhookEvent(event: WebhookEvent, workflowId: string) {
  try {
    await (await temporal()).workflow.start('WebhookEventWorkflow', {
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workflowId,
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      args: [event],
    });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }
}

/**
 * Contract with services/worker-py (worker/privacy.py): one data-subject request (docs/privacy.md).
 * Ids only; the worker reads everything else from the DB and the tools.
 */
export type PrivacyRequest = {
  requestId: string;
  kind: 'export' | 'deletion';
  subjectType: 'user' | 'org';
  subjectId: string;
  /** ISO time: a deletion waits until then (grace period) and can be cancelled meanwhile. */
  executeAfter: string;
  /** Export: the "ready" mail, sent by the worker once the ZIP is stored. */
  email?: SendEmail;
  /** User deletion: GA4 client id from the requesting browser's `_ga` cookie (GA4 User Deletion). */
  gaClientId?: string;
};
export const privacyWorkflowId = (r: Pick<PrivacyRequest, 'kind' | 'requestId'>) =>
  `privacy-${r.kind}-${r.requestId}`;

/** One workflow per request id; the request row is the idempotency key. */
export const startPrivacyRequest = (r: PrivacyRequest) =>
  startOnce(
    r.kind === 'export' ? 'DataExportWorkflow' : 'DataDeletionWorkflow',
    privacyWorkflowId(r),
    r,
  );

/** Wakes a deletion in its grace period; it re-reads the row (already `cancelled`) and stops. */
export async function signalPrivacyCancel(requestId: string) {
  await (await temporal()).workflow
    .getHandle(privacyWorkflowId({ kind: 'deletion', requestId }))
    .signal('cancel');
}
