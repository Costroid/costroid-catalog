function splitCells(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

const isSeparator = (cells) => cells.every((cell) => /^:?-+:?$/.test(cell));

export function requireMatch(text, pattern, what) {
  const match = pattern.exec(text);
  if (!match) throw new Error(`${what} not found on the page`);
  return match;
}

export function parseTables(text) {
  const tables = [];
  let current = null;
  text.split('\n').forEach((line, index) => {
    if (!line.trim().startsWith('|')) {
      current = null;
      return;
    }
    const cells = splitCells(line);
    if (current === null) {
      current = { header: cells, rows: [], line: index };
      tables.push(current);
    } else if (!isSeparator(cells) && cells.some((cell) => cell !== '')) {
      current.rows.push(Object.fromEntries(current.header.map((name, at) => [name, cells[at] ?? ''])));
    }
  });
  return tables;
}

// Splits a page into the text under each heading at the given level, keyed by the heading's own words.
export function sections(text, level) {
  const marker = `${'#'.repeat(level)} `;
  const found = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith(marker)) {
      current = { heading: line.slice(marker.length).trim(), lines: [] };
      found.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return found.map(({ heading, lines }) => ({ heading, body: lines.join('\n') }));
}

export function stripMarkup(cell) {
  return cell
    .replace(/<sup>.*?<\/sup>/g, '')
    .replace(/\[\^[^\]]*\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

// "$12.50 / MTok" and "$2.00" keep their published digits. "-" and "" read as null.
export function moneyOf(cell) {
  const text = stripMarkup(cell);
  if (text === '' || text === '-' || text === 'Not applicable') return null;
  const match = /^\$(\d+(?:\.\d+)?)(?: USD)?(?: \/ MTok)?$/.exec(text);
  if (!match) throw new Error(`unreadable price cell: ${JSON.stringify(cell)}`);
  return match[1];
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function isoDate(words) {
  const match = /^(\w+) (\d{1,2}), (\d{4})$/.exec(words);
  const month = match && MONTHS.indexOf(match[1]);
  if (!match || month < 0) throw new Error(`unreadable date: ${JSON.stringify(words)}`);
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

export function dayAfter(iso) {
  const next = new Date(`${iso}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
