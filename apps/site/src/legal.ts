// Legal pages generated from config (docs/legal.md): config/legal.json for the company, versions
// and the processor catalog; config/plans.json for the refund terms per pricing model;
// config/components.json + the deployment's answers file + the build env for what is in use.
// Pure functions without imports: the site renders them, scripts/check-legal.mjs (Node, type
// stripping) checks and hashes them. TEMPLATES for a lawyer to review; they never claim
// compliance with any law.

export const DOC_IDS = ['privacy', 'terms', 'refunds', 'cookies', 'imprint'] as const;
export type DocId = (typeof DOC_IDS)[number];

type Cookie = { name: string; purpose: string; duration: string };
export type Processor = {
  id: string;
  component: string;
  name: string;
  category: 'necessary' | 'service' | 'functional' | 'analytics' | 'marketing';
  purpose: string;
  data: string;
  /** Build env keys that turn the tool on in the browser (all must be set). */
  env?: string[];
  /** Component modes (deploy answers) in which the server uses it too; without `env`: any but skip. */
  modes?: string[];
  cookies?: Cookie[];
};
export type LegalConfig = {
  template: boolean;
  company: Record<
    | 'legalName'
    | 'productName'
    | 'address'
    | 'registration'
    | 'vatId'
    | 'representative'
    | 'email'
    | 'privacyEmail',
    string
  >;
  governingLaw: string;
  jurisdiction: string;
  age: { minimum: number; b2bOnly: boolean };
  /** Session lifetime in days (the API's auth config reads it too). */
  sessionDays: number;
  documents: Record<DocId, { title: string; version: string; effective: string }>;
  refunds: { withdrawalDays: number; creditsRefundDays: number };
  billing: { taxNote: string };
  processors: Processor[];
};
type Component = { id: string; tier: string };
type Answers = { components?: Record<string, { mode?: string }> };
type Plans = { plans: Record<string, { prices?: Record<string, unknown> }> };

export type Section = {
  heading: string;
  paragraphs?: string[];
  items?: string[];
  table?: { columns: string[]; rows: string[][] };
  /** Follows the tools in use, outside the accepted version (not in config/legal.lock.json). */
  generated?: boolean;
};
export type LegalDoc = {
  id: DocId;
  title: string;
  version: string;
  effective: string;
  sections: Section[];
};

/** Site path of a legal page. */
export const legalPath = (id: DocId) => `/legal/${id}/`;

/**
 * Whether a processor is in use: a browser tool when its env keys are set at build time (it only
 * loads then); on the server when its component's mode in the deployment's answers file is one of
 * `modes` (any but skip when it has no `env`), or, without an answers file, when it is core.
 */
export function inUse(
  p: Processor,
  components: Component[],
  env: Record<string, string | undefined>,
  answers?: Answers,
): boolean {
  if (p.env?.length && p.env.every((k) => Boolean(env[k]))) return true;
  const c = components.find((x) => x.id === p.component);
  if (!c) return false;
  const mode = answers?.components?.[c.id]?.mode;
  if (p.env?.length && !p.modes) return false; // browser only
  if (!mode) return c.tier === 'core' && !p.modes;
  return p.modes ? p.modes.includes(mode) : mode !== 'skip';
}

/** The text a lock hash covers: everything but the generated lists of tools in use. */
export const versionedText = (d: LegalDoc) =>
  d.sections.map((s) => (s.generated ? { ...s, table: undefined, items: undefined } : s));

/** Pricing models the plans use (docs/billing.md): a price without `model` is flat. */
export function pricingModels(plans: Plans): Set<string> {
  const models = new Set<string>();
  for (const plan of Object.values(plans.plans)) {
    for (const price of Object.values(plan.prices ?? {})) {
      for (const c of [price].flat() as { model?: string }[]) models.add(c.model ?? 'flat');
    }
  }
  return models;
}

/**
 * A deployment's own details over the repo's config (SITE_LEGAL_JSON, docs/legal.md): top-level
 * keys replace the config's, `company` merges field by field, and `processors` entries merge by
 * `id` into the catalog (`[{ "id": "hosting", "name": "..." }]`), so a deployment names its real
 * providers without copying the catalog.
 */
export function withOverride(base: LegalConfig, raw: string | undefined): LegalConfig {
  if (!raw) return base;
  const o = JSON.parse(raw) as Partial<LegalConfig>;
  const named = new Map((o.processors ?? []).map((p) => [p.id, p]));
  return {
    ...base,
    ...o,
    company: { ...base.company, ...(o.company ?? {}) },
    processors: base.processors.map((p) => ({ ...p, ...(named.get(p.id) ?? {}) })),
  };
}

/**
 * Example values a page would still show: none are allowed once `template` is false. The build
 * refuses them, because a deployment can turn the template off at build time (SITE_LEGAL_JSON)
 * where `pnpm check:legal` never looks.
 */
export function exampleValues(config: LegalConfig, processors: Processor[]): string[] {
  if (config.template) return [];
  const texts: [string, unknown][] = [
    ...Object.entries(config.company).map(([k, v]) => [`company.${k}`, v] as [string, unknown]),
    ['governingLaw', config.governingLaw],
    ['jurisdiction', config.jurisdiction],
    ...processors.map((p) => [`processors.${p.id}.name`, p.name] as [string, unknown]),
  ];
  return texts.filter(([, v]) => typeof v === 'string' && /example/i.test(v)).map(([k]) => k);
}

const TEMPLATE_NOTE =
  'This text is a template generated from the product configuration. It has not been reviewed by a lawyer and does not claim compliance with any law. Have it reviewed for every country you sell in before relying on it.';

/** The five documents for one build. `processors` are the ones in use (see inUse). */
export function legalDocs(
  config: LegalConfig,
  processors: Processor[],
  plans: Plans,
): Record<DocId, LegalDoc> {
  const c = config.company;
  const product = c.productName;
  const doc = (id: DocId, sections: Section[]): LegalDoc => ({
    id,
    ...config.documents[id],
    sections: config.template
      ? [{ heading: 'Template', paragraphs: [TEMPLATE_NOTE] }, ...sections]
      : sections,
  });
  const age = config.age.b2bOnly
    ? `${product} is for businesses and professionals. Do not use it as a consumer or if you are under 18.`
    : `You must be at least ${config.age.minimum} years old to create an account; sign-up asks you to confirm it. We do not knowingly collect data of younger children. If you believe a child gave us personal data, write to ${c.privacyEmail} and we will delete it.`;
  const cookieTools = processors.filter((p) => p.cookies?.length);
  const consentTools = processors.filter((p) =>
    ['analytics', 'marketing', 'functional'].includes(p.category),
  );
  const models = pricingModels(plans);
  const subscription = models.has('flat') || models.has('per_seat');

  const privacy = doc('privacy', [
    {
      heading: 'Who we are',
      paragraphs: [
        `${c.legalName} (${c.address}) runs ${product} and is the controller of your account data. Contact: ${c.privacyEmail}.`,
        `For the data an organization puts into its workspace (projects, files, AI requests), the organization is the controller and we process it on its behalf.`,
      ],
    },
    {
      heading: 'What we collect and why',
      items: [
        'Account data: name, email address, sign-in methods, sessions (IP address, browser). Needed to provide the service (contract).',
        'Workspace data: what you and your organization create or upload. Processed for the organization that owns it (contract).',
        'AI requests and responses, when you use AI features: kept as an audit record and deleted after the retention period (legal obligation, contract).',
        'Security and audit records: who changed what and from which IP address (legitimate interest in security and accountability).',
        'Product analytics, only where you consent (consent). Cookieless analytics may run without consent where the law allows it.',
        'Proof of what you accepted: the versions of these terms and this policy you accepted, when, and your age confirmation (legal obligation).',
        'Marketing email, only if you opt in (consent). Account email such as sign-in codes and invitations is part of the service.',
      ],
    },
    {
      heading: 'Who processes your data',
      paragraphs: [
        'The service providers below process personal data on our behalf. This list follows the tools this deployment uses and can change without a new version of this policy.',
      ],
      generated: true,
      table: {
        columns: ['Provider', 'Purpose', 'Data'],
        rows: processors
          .filter((p) => p.category !== 'necessary')
          .map((p) => [p.name, p.purpose, p.data]),
      },
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        'Account data: while your account exists. After you delete your account it is erased after a short grace period, except records the law or accountability requires (the audit record of AI calls and of security events, without your name or email).',
        'AI request and response content, data exports and deleted organizations follow fixed retention periods, enforced every day.',
        'Backups keep deleted data until they expire.',
      ],
    },
    {
      heading: 'Your rights',
      paragraphs: [
        'You can download all your data and delete your account in Settings, Privacy. You can also ask us to correct, restrict or stop processing your data, or object to it, by writing to the privacy contact above. You may complain to your data protection authority.',
        'You can withdraw consent at any time: analytics in Cookie settings, marketing email with the unsubscribe link in every such email or in Settings, Privacy.',
      ],
    },
    { heading: 'Children', paragraphs: [age] },
    {
      heading: 'International transfers',
      paragraphs: [
        'Some providers above may process data outside your country. Where the law requires it, transfers rely on appropriate safeguards such as standard contractual clauses.',
      ],
    },
    {
      heading: 'Changes',
      paragraphs: [
        'When this policy changes, its version changes and we ask you to review it the next time you use the service.',
      ],
    },
  ]);

  const terms = doc('terms', [
    {
      heading: 'Agreement',
      paragraphs: [
        `These terms are an agreement between you and ${c.legalName} for the use of ${product}. By creating an account you accept them and the privacy policy.`,
      ],
    },
    {
      heading: 'Your account',
      paragraphs: [
        age,
        'Keep your sign-in methods secure. You are responsible for what happens in your account.',
      ],
    },
    {
      heading: 'Acceptable use',
      items: [
        'No unlawful content, malware, spam or attempts to break the service or other customers’ data.',
        'No reselling access unless we agree to it in writing.',
        'AI features produce output that can be wrong. Review it before you rely on it.',
      ],
    },
    {
      heading: 'Your content',
      paragraphs: [
        'Your organization owns what it puts into its workspace. You give us the rights needed to host and process it to provide the service. You can export or delete it at any time.',
      ],
    },
    {
      heading: 'Plans, payment and renewal',
      paragraphs: [
        subscription
          ? 'Paid plans renew automatically at the end of each billing period until you cancel. The billing page shows the price, the billing period and the next renewal date before you pay. You can cancel any time in Billing, in as few steps as it took to subscribe; the plan stays active until the end of the paid period.'
          : 'Paid use is billed as described on the billing page.',
        config.billing.taxNote,
        'Refunds follow the refund and cancellation policy.',
      ],
    },
    {
      heading: 'Availability and changes',
      paragraphs: [
        'We work to keep the service available but do not promise it will be uninterrupted. We may change features; we will tell you in advance about changes that reduce what a paid plan includes.',
      ],
    },
    {
      heading: 'Ending the agreement',
      paragraphs: [
        'You can delete your account at any time in Settings, Privacy. We may suspend or close accounts that break these terms, and will tell you why unless the law forbids it.',
      ],
    },
    {
      heading: 'Liability',
      paragraphs: [
        'To the extent the law allows, our liability is limited to the amount you paid in the twelve months before the claim. Nothing in these terms limits liability that cannot be limited by law, or your statutory rights as a consumer.',
      ],
    },
    {
      heading: 'Law and disputes',
      paragraphs: [
        `These terms are governed by ${config.governingLaw}. Disputes go to ${config.jurisdiction}, unless the law of your country gives you, as a consumer, the right to bring them at home.`,
      ],
    },
    {
      heading: 'Changes to these terms',
      paragraphs: [
        'When these terms change, their version changes and we ask you to accept the new version the next time you use the service.',
      ],
    },
    { heading: 'Contact', paragraphs: [`${c.legalName}, ${c.address}, ${c.email}.`] },
  ]);

  const refundSections: Section[] = [];
  if (subscription) {
    refundSections.push({
      heading: 'Subscriptions',
      paragraphs: [
        'Cancel any time in Billing. Cancelling stops the next renewal; the plan stays active until the end of the period you paid for, and we do not charge you again.',
        'Periods already started are not refunded, except where the law requires it or we charged you in error.',
      ],
    });
  }
  if (models.has('metered')) {
    refundSections.push({
      heading: 'Usage-based charges',
      paragraphs: [
        'Usage is billed after it happens and is not refundable, except for billing errors. You can cap AI spending with the limit on the billing page.',
      ],
    });
  }
  if (models.has('credits')) {
    refundSections.push({
      heading: 'Prepaid credits',
      paragraphs: [
        `Unused credits can be refunded within ${config.refunds.creditsRefundDays} days of purchase. Credits expire as stated when you buy them.`,
      ],
    });
  }
  if (models.has('contract')) {
    refundSections.push({
      heading: 'Contracts',
      paragraphs: [
        'Plans sold under a signed contract follow the cancellation and refund terms of that contract.',
      ],
    });
  }
  const refunds = doc('refunds', [
    ...refundSections,
    {
      heading: 'Consumers’ right of withdrawal',
      paragraphs: config.age.b2bOnly
        ? ['The service is sold to businesses only; consumer withdrawal rights do not apply.']
        : [
            `If you are a consumer, the law of your country may let you withdraw from a purchase within ${config.refunds.withdrawalDays} days. Where you asked us to start the service in that time, the refund can be reduced for what you already used.`,
          ],
    },
    {
      heading: 'How to ask for a refund',
      paragraphs: [`Write to ${c.email} with your organization name and the invoice number.`],
    },
  ]);

  const cookies = doc('cookies', [
    {
      heading: 'What we use',
      paragraphs: [
        consentTools.length
          ? 'Cookies and similar storage are small pieces of data a site keeps in your browser. Strictly necessary ones run always. Everything else runs only after you agree, and you can change your choice any time with Cookie settings at the bottom of the page.'
          : 'Cookies and similar storage are small pieces of data a site keeps in your browser. This deployment uses only strictly necessary ones, so there is nothing to agree to and no cookie banner.',
        'This list follows the tools this deployment uses and can change without a new version of this policy.',
      ],
      generated: true,
      table: {
        columns: ['Tool', 'Cookie', 'Purpose', 'Duration', 'Needs consent'],
        rows: cookieTools.flatMap((p) =>
          (p.cookies ?? []).map((k) => [
            p.name,
            k.name,
            k.purpose,
            k.duration.replace('{sessionDays}', String(config.sessionDays)),
            p.category === 'necessary' ? 'No' : 'Yes',
          ]),
        ),
      },
    },
    {
      heading: 'Tools that need your consent',
      paragraphs: [
        consentTools.length
          ? 'These tools load only after you agree, or not at all where they are cookieless and the law allows it:'
          : 'This deployment uses no analytics, marketing or third-party tools that need consent.',
      ],
      generated: true,
      items: consentTools.map((p) => `${p.name}: ${p.purpose}`),
    },
  ]);

  const imprint = doc('imprint', [
    {
      heading: 'Provider',
      items: [
        `Legal name: ${c.legalName}`,
        `Address: ${c.address}`,
        `Registration: ${c.registration}`,
        `VAT number: ${c.vatId}`,
        `Represented by: ${c.representative}`,
        `Email: ${c.email}`,
      ],
    },
  ]);

  return { privacy, terms, refunds, cookies, imprint };
}
