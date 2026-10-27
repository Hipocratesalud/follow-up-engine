// @ts-check
/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- an ESLint rule module, typed by its JSDoc */
/**
 * `inbox/no-literal-copy`: user-facing words live in the catalogs
 * (src/i18n/en.ts and es.ts), never inline in a component. Reports JSX text
 * with letters, and string literals (or templates with letters outside
 * their expressions) given to the props a user reads or hears: aria-label,
 * title, placeholder, alt, label and friends, or rendered as a JSX child.
 *
 * Clinical content is data from the API or the record, never a literal, so
 * it never trips the rule. The allowlist is for words that are the same in
 * every language: brand and product names, codes and units.
 */

/** Props whose string value reaches the user. */
const COPY_PROPS = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'title',
  'placeholder',
  'alt',
  'label',
  'hint',
  'description',
  'notFoundTitle',
  'backLabel',
]);

/** Words that read the same in every UI language. */
const ALLOWED = new Set(['WhatsApp', 'Muse Spark', 'Meta', 'FHIR', 'JSON', 'SMS', 'HbA1c', 'TSH']);

const LETTER = /\p{L}/u;

/** @param {string} text */
function isCopy(text) {
  const trimmed = text.trim();
  return trimmed !== '' && LETTER.test(trimmed) && !ALLOWED.has(trimmed);
}

/** @param {any} node */
function literalText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral') {
    return node.quasis.map((/** @type {any} */ quasi) => quasi.value.cooked ?? '').join(' ');
  }
  return undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noLiteralCopy = {
  meta: {
    type: 'problem',
    docs: { description: 'User-facing copy comes from the i18n catalogs, never a literal' },
    messages: {
      text: 'Hard-coded UI text "{{text}}": add it to src/i18n/en.ts and es.ts and read it with useT().',
      prop: 'Hard-coded "{{prop}}" text "{{text}}": add it to the i18n catalogs.',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXText(node) {
        if (isCopy(node.value)) {
          context.report({ node, messageId: 'text', data: { text: node.value.trim() } });
        }
      },
      JSXExpressionContainer(node) {
        // `{'Texto'}` or `{`Texto ${x}`}` rendered as a child.
        if (node.parent.type !== 'JSXElement' && node.parent.type !== 'JSXFragment') return;
        const text = literalText(node.expression);
        if (text !== undefined && isCopy(text)) {
          context.report({ node, messageId: 'text', data: { text: text.trim() } });
        }
      },
      JSXAttribute(node) {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : '';
        if (!COPY_PROPS.has(name) || node.value === null) return;
        const value =
          node.value.type === 'JSXExpressionContainer' ? node.value.expression : node.value;
        const text = literalText(value);
        if (text !== undefined && isCopy(text)) {
          context.report({ node, messageId: 'prop', data: { prop: name, text: text.trim() } });
        }
      },
    };
  },
};
