import { Link } from '@tanstack/react-router';
import { ArrowLeft, Sparkles } from 'lucide-react';
import models from '../../../../config/ai-models.json';
import page from '../../../../config/ai-transparency.json';

type Model = { provider: string; model: string; purposes: string[] };
const contours = Object.entries(models.contours as Record<string, Model[]>);

/** Public page: what AI is used for, which models, and how to contest a result. */
export function AiTransparencyPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-8 p-4 md:p-8">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to the app
      </Link>
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Sparkles className="size-5 text-primary" aria-hidden /> How we use AI
        </h1>
        <p className="text-muted-foreground">
          {page.operator} uses AI models for the features below. Content they produce is labeled
          "AI-generated" in the app. Last updated {page.updated}.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">What AI is used for</h2>
        {page.uses.map((use) => (
          <div key={use.purpose} className="space-y-2 rounded-lg border p-4">
            <h3 className="font-medium">{use.title}</h3>
            <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted-foreground">What it does</dt>
              <dd>{use.what}</dd>
              <dt className="text-muted-foreground">Data sent</dt>
              <dd>{use.data}</dd>
              <dt className="text-muted-foreground">Human oversight</dt>
              <dd>{use.oversight}</dd>
              <dt className="text-muted-foreground">Models</dt>
              <dd>
                {contours
                  .map(([contour, list]) => {
                    const used = list.filter((m) => m.purposes.includes(use.purpose));
                    return used.length
                      ? `${contour.toUpperCase()}: ${used.map((m) => `${m.model} (${m.provider})`).join(', ')}`
                      : '';
                  })
                  .filter(Boolean)
                  .join('; ')}
              </dd>
            </dl>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Contest or correct a result</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {page.contest.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="text-sm">
          Contact:{' '}
          <a className="underline" href={`mailto:${page.contact}`}>
            {page.contact}
          </a>
        </p>
      </section>
    </main>
  );
}
