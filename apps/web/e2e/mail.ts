// Shared by the e2e specs.
// The worker delivers every mail to the compose Mailpit; read it like the user's inbox would.
const mailpit = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export async function mailedLink(to: string, subject: RegExp): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const query = new URLSearchParams({ query: `to:${to}` });
    const { messages } = await (await fetch(`${mailpit}/api/v1/search?${query}`)).json();
    const hit = messages.find((m: { Subject: string }) => subject.test(m.Subject));
    if (hit) {
      const mail = await (await fetch(`${mailpit}/api/v1/message/${hit.ID}`)).json();
      const link = new URL(mail.Text.match(/https?:\/\/[^\s\]]+/)[0]);
      return link.pathname + link.search; // same app, whatever port the test server runs on
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail to ${to} in Mailpit: are Mailpit and the worker (pnpm worker) up?`);
}
