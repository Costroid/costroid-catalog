const IGNORED = new Set(['RetrievalDate', 'SourceSha256']);

const changedFields = (before, after) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => !IGNORED.has(field))
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));

export function diffSheets(beforeSheets, afterSheets) {
  const index = (sheets) =>
    new Map(sheets.flatMap((sheet) => sheet.rows.map((row) => [row.SkuPriceId, { provider: sheet.Provider, row }])));
  const before = index(beforeSheets);
  const after = index(afterSheets);
  const added = [...after].filter(([id]) => !before.has(id)).map(([, entry]) => entry);
  const removed = [...before].filter(([id]) => !after.has(id)).map(([, entry]) => entry);
  const changed = [...after]
    .filter(([id]) => before.has(id))
    .map(([id, entry]) => ({ id, provider: entry.provider, fields: changedFields(before.get(id).row, entry.row) }))
    .filter(({ fields }) => fields.length > 0);
  return { added, removed, changed };
}

const countBy = (entries) => {
  const counts = new Map();
  for (const { provider } of entries) counts.set(provider, (counts.get(provider) ?? 0) + 1);
  return counts;
};

export function renderDiff({ added, removed, changed }, { version, previous }) {
  const providers = [...new Set([...added, ...removed, ...changed].map(({ provider }) => provider))];
  const [plus, minus, moved] = [countBy(added), countBy(removed), countBy(changed)];
  const lines = [
    `# Catalog ${version}: diff against ${previous ?? 'nothing'}`,
    '',
    previous ? `Rows compared by SkuPriceId with sheets from ${previous}.` : 'First release. Every row is new.',
    '',
    '| Sheet | Added | Removed | Changed |',
    '| ----- | ----- | ------- | ------- |',
    ...providers.map(
      (provider) =>
        `| ${provider} | ${plus.get(provider) ?? 0} | ${minus.get(provider) ?? 0} | ${moved.get(provider) ?? 0} |`,
    ),
    '',
  ];
  if (changed.length > 0) {
    lines.push('## Changed', '', '| SkuPriceId | Field | Before | After |', '| ---------- | ----- | ------ | ----- |');
    for (const { id, fields } of changed) {
      for (const { field, before, after } of fields) {
        lines.push(`| \`${id}\` | ${field} | ${JSON.stringify(before)} | ${JSON.stringify(after)} |`);
      }
    }
    lines.push('');
  }
  if (previous) {
    for (const [title, entries] of [
      ['Added', added],
      ['Removed', removed],
    ]) {
      if (entries.length > 0) lines.push(`## ${title}`, '', ...entries.map(({ row }) => `- \`${row.SkuPriceId}\``), '');
    }
  }
  return lines.join('\n');
}
