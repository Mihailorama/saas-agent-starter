// Fixed sample data for the dev gallery: no dates from the clock, no randomness, so the
// visual regression screenshots are stable. Names are invented; never put real data here.

export type SampleProject = {
  id: string;
  name: string;
  owner: string;
  status: 'Active' | 'Paused' | 'Archived';
  updated: string;
  files: number;
};

const names = [
  'Apollo',
  'Borealis',
  'Cassini',
  'Dynamo',
  'Equinox',
  'Fathom',
  'Galileo',
  'Halcyon',
  'Ion',
  'Juniper',
  'Kepler',
  'Lumen',
  'Meridian',
  'Nimbus',
];
const owners = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson'];
const statuses: SampleProject['status'][] = ['Active', 'Active', 'Paused', 'Archived'];

export const sampleProjects: SampleProject[] = names.map((name, i) => ({
  id: `p${i + 1}`,
  name,
  owner: owners[i % owners.length]!,
  status: statuses[i % statuses.length]!,
  updated: `Jan ${String(28 - i).padStart(2, '0')}, 2026`,
  files: (i * 7) % 12,
}));

export const ownerOptions = owners.map((o) => ({
  value: o.toLowerCase().replace(/\s+/g, '-'),
  label: o,
}));

/** Calendar month shown in the gallery (instead of "today"). */
export const sampleMonth = new Date(2026, 0, 1);
export const sampleDate = new Date(2026, 0, 14);
