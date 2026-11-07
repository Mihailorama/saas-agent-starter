import { createHash } from 'node:crypto';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry/lib/client';
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

/** Idempotent: the workflow id is derived from the project id, duplicates are rejected. */
export async function startProjectCreated(event: ProjectCreated) {
  try {
    await (await temporal()).workflow.start('ProjectCreatedWorkflow', {
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workflowId: projectWorkflowId(event.projectId),
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      args: [event],
    });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }
}

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
