/**
 * Reading and rewriting the env files Node loads with `--env-file`.
 *
 * The rule here is that an edit changes the lines it names and nothing else.
 * Comments, blank lines, ordering, line endings and a leading byte-order mark
 * all survive, so a file someone annotated by hand stays readable, and a diff
 * of the file before and after an edit shows only the edit.
 *
 * Parsing follows Node's own reader closely enough that what the dashboard
 * shows is what the services will see: `export ` is allowed, the last
 * occurrence of a key wins, quoted values may span lines, double quotes expand
 * `\n`, and an unquoted value ends at the first `#`.
 */

const NEW_KEY = /^[A-Z_][A-Z0-9_]*$/;
const ENTRY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
const QUOTES = new Set(['"', "'", "`"]);

/**
 * @typedef {{ type: "blank" | "comment" | "other", raw: string }} PlainNode
 * @typedef {{ type: "entry", raw: string, key: string, value: string, warning?: string }} EntryNode
 * @typedef {PlainNode | EntryNode} EnvNode
 * @typedef {{ nodes: EnvNode[], eol: string, bom: boolean }} EnvDocument
 */

/** @param {string} text @returns {EnvDocument} */
export function parseEnv(text) {
  const bom = text.startsWith("\uFEFF");
  const body = bom ? text.slice(1) : text;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  /** @type {EnvNode[]} */
  const nodes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") {
      nodes.push({ type: "blank", raw: line });
      continue;
    }
    if (trimmed.startsWith("#")) {
      nodes.push({ type: "comment", raw: line });
      continue;
    }
    const match = ENTRY.exec(line);
    if (!match) {
      nodes.push({ type: "other", raw: line });
      continue;
    }

    const key = match[1];
    const rest = match[2];
    const quote = rest[0];
    if (QUOTES.has(quote)) {
      let inner = rest.slice(1);
      let close = inner.indexOf(quote);
      let last = i;
      while (close === -1 && last + 1 < lines.length) {
        last += 1;
        inner += "\n" + lines[last];
        close = inner.indexOf(quote);
      }
      if (close !== -1) {
        let value = inner.slice(0, close);
        if (quote === '"') value = value.replace(/\\n/g, "\n");
        nodes.push({
          type: "entry",
          key,
          value,
          raw: lines.slice(i, last + 1).join("\n"),
        });
        i = last;
        continue;
      }
      nodes.push({
        type: "entry",
        key,
        value: unquoted(rest),
        raw: line,
        warning: "This value opens a quote it never closes.",
      });
      continue;
    }
    nodes.push({ type: "entry", key, value: unquoted(rest), raw: line });
  }
  return { nodes, eol, bom };
}

/** @param {string} rest */
function unquoted(rest) {
  const hash = rest.indexOf("#");
  return (hash === -1 ? rest : rest.slice(0, hash)).trim();
}

/** @param {EnvDocument} doc @returns {string} */
export function serializeEnv(doc) {
  const text = doc.nodes.map((node) => node.raw).join("\n");
  return (
    (doc.bom ? "\uFEFF" : "") +
    (doc.eol === "\n" ? text : text.replace(/\n/g, doc.eol))
  );
}

/**
 * The effective value of every key, as the services would load it.
 *
 * @param {EnvDocument} doc
 * @returns {Map<string, { value: string, occurrences: number, warning?: string }>}
 */
export function entriesOf(doc) {
  const out = new Map();
  for (const node of doc.nodes) {
    if (node.type !== "entry") continue;
    const previous = out.get(node.key);
    out.set(node.key, {
      value: node.value,
      occurrences: (previous?.occurrences ?? 0) + 1,
      ...(node.warning ? { warning: node.warning } : {}),
    });
  }
  return out;
}

/**
 * Writes a value so that Node reads back exactly that value.
 *
 * Plain values stay unquoted, so a hand-written `D:\media` is not rewritten as
 * `'D:\media'` just because it was saved once. Anything Node would otherwise
 * trim or cut at a `#` is quoted, in whichever quote the value does not
 * contain. Single quotes come first because Node reads them literally.
 *
 * @param {string} value
 * @returns {string}
 */
export function formatValue(value) {
  if (typeof value !== "string")
    throw new EnvValueError("A value must be text.");
  if (/[\r\n\0]/.test(value))
    throw new EnvValueError("A value cannot contain a line break.");
  if (value === "") return "";
  const plain =
    value.trim() === value && !value.includes("#") && !QUOTES.has(value[0]);
  if (plain) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes("\\n")) return `"${value}"`;
  if (!value.includes("`")) return "`" + value + "`";
  throw new EnvValueError(
    "This value contains every kind of quote, so it cannot be written safely.",
  );
}

export class EnvValueError extends Error {}

/** @param {string} key */
export function isValidNewKey(key) {
  return typeof key === "string" && NEW_KEY.test(key);
}

/**
 * Returns a new document with `set` written and `unset` removed.
 *
 * A key that is already present is rewritten where it stands, at its first
 * occurrence; later duplicates are dropped, since Node would have let the last
 * one win and the reader would have been looking at the wrong line. A new key
 * goes at the end, before the file's final newline.
 *
 * @param {EnvDocument} doc
 * @param {{ set?: Record<string, string>, unset?: string[] }} change
 * @returns {EnvDocument}
 */
export function applyChange(doc, { set = {}, unset = [] }) {
  const existing = new Set(entriesOf(doc).keys());
  for (const key of Object.keys(set)) {
    if (!existing.has(key) && !isValidNewKey(key)) {
      throw new EnvValueError(
        `${key} is not a valid name. Use capital letters, digits and underscores.`,
      );
    }
  }
  const removing = new Set(unset);
  const written = new Set();
  /** @type {EnvNode[]} */
  const nodes = [];

  for (const node of doc.nodes) {
    if (node.type !== "entry") {
      nodes.push(node);
      continue;
    }
    if (removing.has(node.key)) continue;
    if (Object.hasOwn(set, node.key)) {
      if (written.has(node.key)) continue;
      written.add(node.key);
      nodes.push(entryNode(node.key, set[node.key]));
      continue;
    }
    nodes.push(node);
  }

  const additions = Object.keys(set)
    .filter((key) => !written.has(key))
    .map((key) => entryNode(key, set[key]));
  if (additions.length > 0) {
    const endsWithNewline =
      nodes.length > 0 &&
      nodes[nodes.length - 1].type === "blank" &&
      nodes[nodes.length - 1].raw === "";
    const at = endsWithNewline ? nodes.length - 1 : nodes.length;
    nodes.splice(at, 0, ...additions);
    if (nodes.length === additions.length)
      nodes.push({ type: "blank", raw: "" });
  }
  return { ...doc, nodes };
}

/** @param {string} key @param {string} value @returns {EntryNode} */
function entryNode(key, value) {
  return { type: "entry", key, value, raw: `${key}=${formatValue(value)}` };
}
