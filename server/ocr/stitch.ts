export interface Screen {
  at: number;
  lines: { text: string; y: number }[];
}

function key(text: string) {
  return text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function similar(left: string, right: string) {
  if (left === right) return true;
  const size = Math.max(left.length, right.length);
  if (size < 9) return false;
  const allowed = Math.floor(size * 0.16);
  if (Math.abs(left.length - right.length) > allowed) return false;
  if (left.length > 200 || right.length > 200) return false;
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j++) {
      next.push(Math.min(row[j + 1] + 1, next[j] + 1, row[j] + Number(left[i] !== right[j])));
    }
    row = next;
  }
  return row[right.length] <= allowed;
}

type Line = { text: string; normalized: string; edgeDistance: number };

function sameLines(left: Line[], right: Line[]) {
  if (left.length !== right.length) return false;
  if (left.length === 1 && Math.min(left[0].normalized.length, right[0].normalized.length) < 8) return false;
  return left.every((line, index) => similar(line.normalized, right[index].normalized));
}

export function stitchScreens(screens: Screen[]) {
  const result: Line[] = [];
  let gaps = 0;
  const edgeCounts = new Map<string, number>();
  const positionKey = (line: Screen['lines'][number]) => {
    if (line.y >= 0.12 && line.y <= 0.91) return '';
    return (line.y < 0.12 ? 'top:' : 'bottom:') + key(line.text);
  };
  for (const { lines } of screens) {
    for (const position of new Set(lines.map(positionKey).filter(Boolean))) {
      edgeCounts.set(position, (edgeCounts.get(position) ?? 0) + 1);
    }
  }
  const cutoff = Math.max(3, Math.ceil(screens.length * 0.7));
  for (const screen of screens) {
    const lines = screen.lines
      .filter((line) => line.y >= 0.038 && line.y <= 0.964 && (edgeCounts.get(positionKey(line)) ?? 0) < cutoff)
      .map(({ text, y }) => ({ text: text.trim(), normalized: key(text), edgeDistance: Math.min(y, 1 - y) }))
      .filter((line) => line.normalized);
    if (!lines.length) continue;
    const limit = Math.min(result.length, lines.length);
    let overlap = 0;
    for (let count = limit; count > 0; count--) {
      if (sameLines(result.slice(-count), lines.slice(0, count))) {
        overlap = count;
        break;
      }
    }
    if (!overlap && result.length) {
      const recent = result.slice(-100);
      const repeated = lines.length <= recent.length && recent.some((_, offset) =>
        offset + lines.length <= recent.length && sameLines(recent.slice(offset, offset + lines.length), lines));
      if (repeated) continue;
      gaps++;
    }
    for (let index = 0; index < overlap; index++) {
      const at = result.length - overlap + index;
      const candidate = lines[index];
      if (result[at].edgeDistance < 0.1 && candidate.edgeDistance - result[at].edgeDistance > 0.1) {
        result[at] = candidate;
      }
    }
    result.push(...lines.slice(overlap));
  }
  return { text: result.map((line) => line.text).join('\n'), gaps, frames: screens.length };
}
