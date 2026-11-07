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
  /** GitHub release tag from the `Released in vX.Y.Z` comment; empty for the close event. */
  release?: string;
};
export const supportClosedWorkflowId = (e: SupportIssueClosed, closeId: string) =>
  `support-closed-${e.tracker}-${e.issueId}-${closeId}`;
export const startSupportIssueClosed = (e: SupportIssueClosed, closeId: string) =>
  startOnce('SupportIssueClosedWorkflow', supportClosedWorkflowId(e, closeId), e);
/** Contract with services/worker-py (worker/mail.py): one rendered email to one recipient. */
export type SendEmail = {
  kind: 'verify-email' | 'reset-password' | 'invitation';
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
