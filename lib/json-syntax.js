// lib/json-syntax.js — 模型 JSON 的一次性、保守语法修复（纯函数）。
//
// 只修封装、标点与未闭合结构；不改写键名、标量或数组元素。修复后仍须由调用方
// 做自己的语义校验（语义拆书还会继续做逐字引文 grounding）。
//
// 解析前额外拒**重复键**：JSON.parse 对同名键静默取最后一个，模型自相矛盾
// 的输出会被无声采信。这里不修、不猜，直接带 JSON 路径与原文片段响亮失败。

function unwrap(text, changes) {
    let out = String(text ?? '').trim();
    const fenced = out.match(/^```(?:json)?\s*\n?([\s\S]*?)(?:\n```\s*|$)/i);
    if (fenced !== null) {
        out = fenced[1].trim();
        changes.push('wrapper');
    }
    const start = out.search(/[\[{]/);
    if (start > 0) {
        out = out.slice(start);
        changes.push('wrapper');
    }
    return out;
}

/** 修一次；无法保守修复时抛错，绝不猜测或补写业务字段。 */
export function repairJsonSyntax(raw) {
    const changes = [];
    const input = unwrap(raw, changes);
    if (input === '') throw new Error('empty JSON');
    const stack = [];
    let out = '';
    let inString = false;
    let escaped = false;
    let closedRoot = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        if (inString) {
            if (escaped) {
                out += char;
                escaped = false;
                continue;
            }
            if (char === '\\') {
                out += char;
                escaped = true;
                continue;
            }
            if (char === '"') {
                out += char;
                inString = false;
                continue;
            }
            const code = char.charCodeAt(0);
            if (code < 0x20) {
                out += char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
                changes.push('control');
                continue;
            }
            out += char;
            continue;
        }

        if (char === '"') {
            out += char;
            inString = true;
            continue;
        }
        if (char === '{' || char === '[') {
            stack.push(char === '{' ? '}' : ']');
            out += char;
            continue;
        }
        if (char === '}' || char === ']') {
            if (stack.length === 0 || stack[stack.length - 1] !== char) throw new Error('mismatched JSON container');
            stack.pop();
            out += char;
            if (stack.length === 0) {
                closedRoot = true;
                if (input.slice(index + 1).trim() !== '') changes.push('wrapper');
                break;
            }
            continue;
        }
        if (char === '，' || char === '：') {
            out += char === '，' ? ',' : ':';
            changes.push('punctuation');
            continue;
        }
        if (char === ',') {
            const rest = input.slice(index + 1);
            if (/^\s*[}\]]/.test(rest)) {
                changes.push('trailing-comma');
                continue;
            }
        }
        out += char;
    }

    if (!closedRoot) {
        if (escaped) {
            // 末尾孤立反斜杠不是可恢复的正文；保留它会让 JSON.parse 响亮失败。
            out += '\\';
        }
        if (inString) {
            out += '"';
            changes.push('close');
        }
        if (stack.length > 0) {
            out += stack.reverse().join('');
            changes.push('close');
        }
    }
    if (changes.length === 0) throw new Error('no conservative JSON repair available');
    return { text: out, changes: [...new Set(changes)] };
}

/** 先严格解析；失败时最多调用一次 repairJsonSyntax，再严格解析一次。 */
export function parseJsonWithSyntaxRepair(raw) {
    const text = String(raw ?? '').trim();
    assertNoDuplicateKey(text);
    try {
        return { value: JSON.parse(text), repaired: false, repairs: [] };
    } catch (originalError) {
        let repaired;
        try { repaired = repairJsonSyntax(text); }
        catch { throw originalError; }
        // 修复只动封装与标点、不删键；修复后再查一遍，是为了让「修复后静默取值」
        // 这条路径也不存在——将来若修复变激进，重复键仍必须在落盘前响亮失败。
        assertNoDuplicateKey(repaired.text);
        return {
            value: JSON.parse(repaired.text),
            repaired: true,
            repairs: repaired.changes,
        };
    }
}

/** 重复键错误：带 JSON 路径（$["a"]["b"]）与原文片段，供工具层原样透出。 */
function duplicateKeyError({ key, path, snippet }) {
    const error = new Error(
        `JSON 含重复键 ${JSON.stringify(key)}（${path}）——同一对象里的重复键只会静默保留最后一个值；`
        + `原文片段：${snippet}`,
    );
    error.code = 'DUPLICATE_JSON_KEY';
    error.key = key;
    error.path = path;
    error.snippet = snippet;
    return error;
}

function snippetAround(source, from, to) {
    const start = Math.max(0, from - 60);
    const end = Math.min(source.length, to + 60);
    const body = source.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${body}${end < source.length ? '…' : ''}`;
}

/**
 * 扫描第一个重复键（只扫不解析，不抛其他错）。
 *
 * 判定只在「对象键位」发生：字符串值（含转义引号 `\"`）里的同名文本不参与比较。
 * 输入本身残缺时尽力而为、返回 null——合法性归 JSON.parse / repairJsonSyntax 判。
 */
function findDuplicateKey(source) {
    const stack = [];
    const top = () => (stack.length > 0 ? stack[stack.length - 1] : null);

    // 数组里的每个元素占一个下标；容器与标量都从这里取路径。
    const beginValue = () => {
        const frame = top();
        if (frame === null) return '$';
        if (frame.type === 'array') {
            const index = frame.count;
            if (frame.expectValue) {
                frame.expectValue = false;
                frame.count += 1;
            }
            return `${frame.path}[${index}]`;
        }
        // 对象里的容器值继承刚读到的键：{"a":{"b":1}} → $["a"]["b"]
        const key = frame.pendingKey;
        if (key === null || key === undefined) return frame.path;
        frame.pendingKey = null;
        return `${frame.path}[${JSON.stringify(key)}]`;
    };

    let inString = false;
    let escaped = false;
    let stringStart = -1;

    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];

        if (inString) {
            if (escaped) { escaped = false; continue; }
            if (char === '\\') { escaped = true; continue; }
            if (char !== '"') continue;
            inString = false;
            const frame = top();
            if (frame !== null && frame.type === 'object' && frame.expectKey) {
                const rawKey = source.slice(stringStart, index + 1);
                let key;
                try { key = JSON.parse(rawKey); } catch { key = rawKey.slice(1, -1); }
                const path = `${frame.path}[${JSON.stringify(key)}]`;
                if (frame.keys.has(key)) {
                    return { key, path, snippet: snippetAround(source, stringStart, index) };
                }
                frame.keys.add(key);
                frame.expectKey = false;
                frame.pendingKey = key;
            } else if (frame !== null && frame.type === 'array' && frame.expectValue) {
                frame.expectValue = false;
                frame.count += 1;
            }
            continue;
        }

        if (char === '"') { inString = true; stringStart = index; escaped = false; continue; }
        if (char === '{') {
            stack.push({ type: 'object', path: beginValue(), keys: new Set(), expectKey: true, pendingKey: null });
            continue;
        }
        if (char === '[') {
            stack.push({ type: 'array', path: beginValue(), count: 0, expectValue: true });
            continue;
        }
        if (char === '}' || char === ']') { stack.pop(); continue; }
        if (char === ':') {
            const frame = top();
            if (frame !== null && frame.type === 'object') frame.expectKey = false;
            continue;
        }
        if (char === ',') {
            const frame = top();
            if (frame === null) continue;
            if (frame.type === 'object') frame.expectKey = true;
            else frame.expectValue = true;
            continue;
        }
        // 字面量（数字 / true / false / null）：只为推进数组下标。
        const frame = top();
        if (frame !== null && frame.type === 'array' && frame.expectValue && !/\s/.test(char)) {
            frame.expectValue = false;
            frame.count += 1;
        }
    }
    return null;
}

function assertNoDuplicateKey(text) {
    const found = findDuplicateKey(text);
    if (found !== null) throw duplicateKeyError(found);
}
