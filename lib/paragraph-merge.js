// lib/paragraph-merge.js — 原稿 / 提案 / 当前稿的保守逐段三路合并（纯函数）。

function paragraphs(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').split(/\n+/).map((x) => x.trim()).filter(Boolean);
}

function same(left, right) {
    return left.length === right.length && left.every((x, i) => x === right[i]);
}

/** LCS  diff：只把双方共有的完整段落当锚点，不在段落内部猜字词合并。 */
function editsAgainstBase(base, variant) {
    const rows = base.length + 1;
    const cols = variant.length + 1;
    const dp = Array.from({ length: rows }, () => new Uint32Array(cols));
    for (let i = base.length - 1; i >= 0; i -= 1) {
        for (let j = variant.length - 1; j >= 0; j -= 1) {
            dp[i][j] = base[i] === variant[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const edits = [];
    let i = 0; let j = 0; let start = 0; let variantStart = 0;
    const flush = (end, variantEnd) => {
        if (start === end && variantStart === variantEnd) return;
        const baseCount = end - start;
        const variantCount = variantEnd - variantStart;
        if (baseCount > 1 && baseCount === variantCount) {
            for (let offset = 0; offset < baseCount; offset += 1) {
                edits.push({ start: start + offset, end: start + offset + 1, texts: [variant[variantStart + offset]] });
            }
            return;
        }
        edits.push({ start, end, texts: variant.slice(variantStart, variantEnd) });
    };
    while (i < base.length || j < variant.length) {
        if (i < base.length && j < variant.length && base[i] === variant[j]) {
            flush(i, j);
            i += 1; j += 1; start = i; variantStart = j;
        } else if (j < variant.length && (i === base.length || dp[i][j + 1] >= dp[i + 1][j])) {
            j += 1;
        } else {
            i += 1;
        }
    }
    flush(i, j);
    return edits;
}

function renderVariant(base, start, end, edits) {
    const out = [];
    let cursor = start;
    for (const edit of edits) {
        out.push(...base.slice(cursor, edit.start), ...edit.texts);
        cursor = edit.end;
    }
    out.push(...base.slice(cursor, end));
    return out;
}

function connectedEditGroups(base, proposedEdits, currentEdits) {
    const all = [
        ...proposedEdits.map((edit) => ({ side: 'proposal', edit })),
        ...currentEdits.map((edit) => ({ side: 'current', edit })),
    ].sort((a, b) => a.edit.start - b.edit.start || a.edit.end - b.edit.end || a.side.localeCompare(b.side));
    const groups = [];
    for (const item of all) {
        const last = groups[groups.length - 1];
        const sameInsertionPoint = last && last.start === last.end
            && item.edit.start === last.start && item.edit.end === item.edit.start;
        if (!last || (item.edit.start >= last.end && !sameInsertionPoint)) {
            groups.push({ start: item.edit.start, end: item.edit.end, items: [item] });
        } else {
            last.end = Math.max(last.end, item.edit.end);
            last.items.push(item);
        }
    }
    return groups.map((group) => ({
        ...group,
        proposedEdits: group.items.filter((x) => x.side === 'proposal').map((x) => x.edit),
        currentEdits: group.items.filter((x) => x.side === 'current').map((x) => x.edit),
    })).filter((group) => group.start <= base.length);
}

export function buildThreeWayMerge(baseText, proposalText, currentText) {
    const base = paragraphs(baseText);
    const proposal = paragraphs(proposalText);
    const current = paragraphs(currentText);
    const groups = connectedEditGroups(base, editsAgainstBase(base, proposal), editsAgainstBase(base, current));
    const rows = [];
    let cursor = 0;
    const pushRow = (start, end, group = null) => {
        const baseLines = base.slice(start, end);
        const proposedLines = group ? renderVariant(base, start, end, group.proposedEdits) : baseLines;
        const currentLines = group ? renderVariant(base, start, end, group.currentEdits) : baseLines;
        const proposalUnchanged = same(proposedLines, baseLines);
        const currentUnchanged = same(currentLines, baseLines);
        const agreement = same(proposedLines, currentLines);
        const conflict = !proposalUnchanged && !currentUnchanged && !agreement;
        const unchanged = proposalUnchanged && currentUnchanged;
        const defaultChoice = agreement || currentUnchanged ? 'proposal' : 'current';
        rows.push({
            id: `R${rows.length + 1}`, base: baseLines, proposal: proposedLines, current: currentLines,
            defaultChoice, conflict,
            status: unchanged ? 'unchanged' : agreement ? 'agreement' : conflict ? 'conflict' : 'single-change',
        });
    };
    for (const group of groups) {
        while (cursor < group.start) { pushRow(cursor, cursor + 1); cursor += 1; }
        pushRow(group.start, group.end, group);
        cursor = group.end;
    }
    while (cursor < base.length) { pushRow(cursor, cursor + 1); cursor += 1; }
    return { rows, conflicts: rows.filter((r) => r.conflict).length };
}

export function mergedText(rows, selections = {}) {
    const out = [];
    for (const row of rows ?? []) {
        const requested = selections[row.id] ?? row.defaultChoice;
        const choice = ['base', 'proposal', 'current'].includes(requested) ? requested : row.defaultChoice;
        out.push(...(row[choice] ?? []));
    }
    return out.join('\n\n');
}
