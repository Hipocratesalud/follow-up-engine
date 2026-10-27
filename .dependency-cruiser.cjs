/**
 * Architectural boundaries of the hexagon (docs/adr/0002-hexagonal-architecture.md).
 * Run with `pnpm boundaries`. Type-only imports count: a port leaking an
 * adapter type is as much a violation as a runtime import.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
const TEST_FILE = '\\.test\\.tsx?$';
/** Test helpers and tool configs (vite, vitest, eslint) are not shipped code. */
const NON_PRODUCTION = [
  '^apps/[^/]+/src/test/',
  '^(packages|apps)/[^/]+/[^/]+\\.config\\.(ts|js|cjs|mjs)$',
  // Test-only package: contract suites on every adapter, end-to-end scenarios.
  '^packages/acceptance/',
];

module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      severity: 'error',
      comment:
        'packages/core is pure domain + ports. It may import only its own files and the ' +
        'allowlisted pure libraries (zod). No workspace packages, no drivers (pg), no vendor SDKs. ' +
        'Put I/O behind a port in packages/core/src/ports and implement it in an adapter package.',
      from: { path: '^packages/core/', pathNot: TEST_FILE },
      to: {
        pathNot: ['^packages/core/', '(^|/)node_modules/zod/'],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'core-no-io-builtins',
      severity: 'error',
      comment:
        'packages/core must not touch the file system, network or processes. ' +
        'Model the capability as a port and implement it in an adapter.',
      from: { path: '^packages/core/' },
      to: {
        dependencyTypes: ['core'],
        path: '^(node:)?(fs|net|http|https|http2|child_process|dgram|tls|cluster|worker_threads|dns)(/|$)',
      },
    },
    {
      name: 'core-tests-only-vitest',
      severity: 'error',
      comment:
        'Core tests may import core files and vitest only (testkit depends on core, not the reverse).',
      from: { path: `^packages/core/.*${TEST_FILE}` },
      to: {
        pathNot: ['^packages/core/', '(^|/)node_modules/(vitest|@vitest|zod)/'],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'fhir-depends-only-on-core',
      severity: 'error',
      comment: 'packages/fhir may depend on packages/core only (among workspace packages).',
      from: { path: '^packages/fhir/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/(core|fhir|testkit)/' },
    },
    {
      name: 'adapters-depend-only-on-core-and-fhir',
      severity: 'error',
      comment:
        'Adapters and the LLM gateway implement ports from core (and may use fhir). ' +
        'They never import each other: wiring adapters together is the job of the apps.',
      from: { path: '^packages/(adapter-[^/]+|llm)/' },
      to: { path: '^packages/', pathNot: ['^packages/(core|fhir)/', '^packages/$1/'] },
    },
    {
      name: 'testkit-only-from-tests',
      severity: 'error',
      comment: 'packages/testkit is test-only. Production code must not import it.',
      from: {
        path: '^(packages|apps)/',
        pathNot: ['^packages/testkit/', TEST_FILE, NON_PRODUCTION[0], NON_PRODUCTION[2]],
      },
      to: { path: '^packages/testkit/' },
    },
    {
      name: 'nothing-imports-acceptance',
      severity: 'error',
      comment: 'packages/acceptance is a leaf of tests: nothing imports it.',
      from: { pathNot: '^packages/acceptance/' },
      to: { path: '^packages/acceptance/' },
    },
    {
      name: 'nothing-imports-apps',
      severity: 'error',
      comment:
        'Apps are composition roots (leaves of the graph). Packages and other apps never import them.',
      from: { path: '^(packages|apps)/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$2/' },
    },
    {
      name: 'packages-import-by-name',
      severity: 'error',
      comment:
        'Import other workspace packages by their name (@follow-up-engine/<name>), never by a ' +
        'relative path into their sources.',
      from: { path: '^(packages|apps)/([^/]+)/' },
      to: {
        dependencyTypes: ['local'],
        path: '^(packages|apps)/',
        pathNot: '^(packages|apps)/$2/',
      },
    },
    {
      name: 'inbox-talks-http-only',
      severity: 'error',
      comment:
        'apps/inbox is a browser app deployed on its own: it reaches the engine through the HTTP API ' +
        '(apps/inbox/src/api) and never imports workspace packages (core, adapters, llm).',
      from: { path: '^apps/inbox/' },
      to: { path: '^packages/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make the hexagon impossible to reason about.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'This module cannot be resolved: missing dependency or typo.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-dependencies',
      severity: 'error',
      comment: 'Every npm import must be declared in a package.json.',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'production-not-to-dev-deps',
      severity: 'error',
      comment: 'Production code must not import devDependencies.',
      from: {
        path: '^(packages|apps)/',
        pathNot: ['^packages/testkit/', TEST_FILE, ...NON_PRODUCTION],
      },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
      mainFields: ['module', 'main', 'types'],
      extensions: ['.ts', '.js', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
