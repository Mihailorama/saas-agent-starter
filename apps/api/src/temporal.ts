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
