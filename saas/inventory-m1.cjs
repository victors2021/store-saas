#!/usr/bin/env node
// MIT. Source inventory only: never boots Medusa, executes SQL or calls an API.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const relative = filename => path.relative(root, filename).split(path.sep).join('/');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.name.startsWith('.') ? [] : entry.isDirectory()
      ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
const moduleFiles = files(path.join(root, 'packages/modules')).filter(f => f.endsWith('.ts'));
const apiFiles = files(path.join(root, 'packages/medusa/src/api')).filter(f => f.endsWith('/route.ts'));
const sources = new Map();
function source(filename) {
  if (!sources.has(filename)) {
    const text = fs.readFileSync(filename, 'utf8');
    sources.set(filename, { text, ast: ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true) });
  }
  return sources.get(filename);
}
const nodeName = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
function unwrap(node) {
  while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
}
function value(node, ast) {
  node = unwrap(node);
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(n => value(n, ast));
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties
    .filter(ts.isPropertyAssignment).map(p => [nodeName(p.name) ?? p.name.getText(ast), value(p.initializer, ast)]));
  return { expression: node.getText(ast) };
}
function visit(node, fn) { fn(node); ts.forEachChild(node, child => visit(child, fn)); }
function callName(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
}
const snake = name => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
const moduleOf = filename => relative(filename).split('/').slice(2, relative(filename).includes('/providers/') ? 4 : 3).join('/');
const controlModules = new Set(['auth', 'user', 'api-key', 'rbac', 'settings']);
const infrastructureModules = new Set(['index', 'search', 'workflow-engine-inmemory', 'workflow-engine-redis', 'providers/locking-postgres']);
function ownership(module, entity) {
  if (module === 'currency') return { category: 'shared_dictionary', phase: 'M1-read-only-dictionary', reviewed: true,
    reason: 'Currency contains immutable currency definitions and no tenant business relationship. Currency mutation is not opened.' };
  if (controlModules.has(module)) return { category: 'tenant_control', phase: ['auth', 'user'].includes(module) ? 'M1' : 'M2', reviewed: ['auth', 'user'].includes(module),
    reason: 'Merchant/customer identity, credentials or merchant configuration must have explicit tenant ownership; this is not a platform superuser bypass.' };
  if (infrastructureModules.has(module)) return { category: 'infrastructure_requires_tenant_envelope', phase: 'M2', reviewed: false,
    reason: 'Persisted workflow/search/index state and lock namespaces need tenant partitioning; do not enable their HTTP or durable worker paths in M1.' };
  if (/Provider$|_provider$/.test(entity)) return { category: 'provider_registry_requires_review', phase: 'M2', reviewed: false,
    reason: 'Separate process-wide provider capability registry from tenant-owned credentials, enabled configuration and relationships before choosing a policy.' };
  return { category: 'tenant_commerce', phase: ['product', 'pricing', 'customer'].includes(module) ? 'M1' : 'M2', reviewed: ['product', 'pricing', 'customer'].includes(module),
    reason: module === 'region' && entity === 'Country'
      ? 'Native country row has a mutable region foreign key; it cannot safely be shared merely because ISO codes are dictionary data.'
      : 'Business records and their relationships are tenant-owned. Phase is planned coverage, not proof that isolation is implemented.' };
}
const modelFiles = moduleFiles.filter(f => f.includes('/src/models/'));
const migrationTables = new Map();
for (const filename of moduleFiles.filter(f => f.includes('/src/migrations/'))) {
  const text = source(filename).text;
  for (const match of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]([a-zA-Z0-9_]+)["`]/gi)) {
    const key = `${moduleOf(filename)}:${match[1]}`;
    if (!migrationTables.has(key)) migrationTables.set(key, []);
    migrationTables.get(key).push(relative(filename));
  }
}
const models = [];
const modelFileExceptions = [];
for (const filename of modelFiles) {
  const { ast } = source(filename);
  let count = 0;
  visit(ast, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || node.expression.name.text !== 'define' || node.expression.expression.getText(ast) !== 'model') return;
    count++;
    const definition = value(node.arguments[0], ast);
    const entity = typeof definition === 'string' ? definition : definition?.name;
    const table = typeof definition === 'object' && typeof definition.tableName === 'string' ? definition.tableName : snake(entity || 'UNKNOWN');
    const module = moduleOf(filename);
    const indexes = [];
    let chained = node;
    while (ts.isPropertyAccessExpression(chained.parent) && chained.parent.expression === chained
      && ts.isCallExpression(chained.parent.parent) && chained.parent.parent.expression === chained.parent) {
      chained = chained.parent.parent;
      if (callName(chained) === 'indexes') indexes.push(...(value(chained.arguments[0], ast) || []));
    }
    let ownerNode = chained;
    while (ownerNode.parent && !ts.isVariableDeclaration(ownerNode) && !ts.isExportAssignment(ownerNode)) ownerNode = ownerNode.parent;
    const declarationName = ts.isVariableDeclaration(ownerNode) ? nodeName(ownerNode.name) : undefined;
    let tenantScopedAnnotation = false;
    visit(ast, child => {
      if (callName(child) === 'tenantScoped' && (child.expression.expression.getText(ast) === declarationName
        || child.expression.expression === chained)) tenantScopedAnnotation = true;
    });
    const fields = [];
    if (node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
      for (const field of node.arguments[1].properties.filter(ts.isPropertyAssignment)) {
        const fieldMethods = [];
        let relation;
        visit(field.initializer, child => {
          const method = callName(child);
          if (method) fieldMethods.push(method);
          if (['belongsTo', 'hasMany', 'manyToMany', 'hasOne'].includes(method)) {
            relation = { type: method, target: child.arguments[0]?.getText(ast), options: value(child.arguments[1], ast) ?? null };
          }
        });
        fields.push({ name: nodeName(field.name), primaryKey: fieldMethods.includes('primaryKey'), unique: fieldMethods.includes('unique'),
          nullable: fieldMethods.includes('nullable'), ...(relation ? { relation } : {}) });
      }
    }
    models.push({ module, entity, table, tableMapping: definition?.tableName ? 'explicit-DML-tableName' : 'native-snake-case-convention',
      migrationCreateTableEvidence: [...new Set(migrationTables.get(`${module}:${table}`) ?? [])],
      file: relative(filename), line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      tenantScopedAnnotation,
      ownership: ownership(module, entity), primaryKey: fields.filter(f => f.primaryKey).map(f => f.name), fields,
      uniqueIndexes: indexes.filter(index => index.unique === true), indexes, sourceSha256: sha256(source(filename).text) });
  });
  if (!count && !filename.endsWith('/index.ts')) modelFileExceptions.push({ file: relative(filename), reason: 'No model.define call found; needs manual review.' });
}
const links = [];
for (const filename of files(path.join(root, 'packages/modules/link-modules/src/definitions')).filter(f => f.endsWith('.ts'))) {
  const { ast } = source(filename);
  visit(ast, node => {
    if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isObjectLiteralExpression(unwrap(node.initializer))) return;
    const config = value(node.initializer, ast);
    if (config.isLink !== true) return;
    links.push({ name: node.name.getText(ast), file: relative(filename), table: config.databaseConfig?.tableName ?? null,
      readOnly: config.isReadOnlyLink === true, relationshipOwnership: 'same-tenant endpoints required except explicit shared dictionary; read-only means query alias, not an authorization bypass',
      phase: config.databaseConfig?.tableName === 'product_variant_price_set' ? 'M1' : 'M2',
      primaryKeys: config.primaryKeys ?? [], relationships: config.relationships ?? [], extensions: config.extends ?? [], sourceSha256: sha256(source(filename).text) });
  });
}
const httpMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ALL']);
// Candidate routes are recommendations only. The middleware remains authoritative.
const candidateM1Routes = new Set([
  'POST /auth/:actor_type/:auth_provider', 'POST /auth/:actor_type/:auth_provider/register',
  'POST /auth/session', 'DELETE /auth/session', 'GET /admin/users/me',
  'POST /store/customers', 'GET /store/customers/me', 'POST /store/customers/me',
  'GET /admin/products', 'POST /admin/products', 'GET /admin/products/:id', 'POST /admin/products/:id', 'DELETE /admin/products/:id',
  'GET /store/products', 'GET /store/products/:id',
]);
const routes = [];
for (const filename of apiFiles) {
  const { ast } = source(filename);
  const exports = new Set();
  const flags = {};
  for (const statement of ast.statements) {
    const exported = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = nodeName(declaration.name);
        if (httpMethods.has(name)) exports.add(name);
        if (['AUTHENTICATE', 'CORS'].includes(name)) flags[name] = value(declaration.initializer, ast);
      }
    }
    if (exported && ts.isFunctionDeclaration(statement) && httpMethods.has(nodeName(statement.name))) exports.add(nodeName(statement.name));
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) if (httpMethods.has(nodeName(element.name))) exports.add(nodeName(element.name));
    }
  }
  const route = '/' + relative(filename).replace('packages/medusa/src/api/', '').replace(/\/route\.ts$/, '').replace(/\[([^\]]+)\]/g, ':$1');
  const domain = route.split('/')[2] || route.split('/')[1];
  routes.push({ path: route, file: relative(filename), methods: [...exports].sort(), flags, domain,
    m1Recommendation: [...exports].filter(method => candidateM1Routes.has(`${method} ${route}`)),
    defaultPolicy: 'deny-unless-explicit-method/path-and-actor/provider-allowlist',
    sourceSha256: sha256(source(filename).text) });
}
const rawSqlCandidates = [];
const sqlCalls = new Set(['raw', 'execute', 'getKnex', 'getTransactionContext', 'createQueryBuilder', 'createNamedQueryBuilder']);
for (const filename of moduleFiles.filter(f => f.includes('/src/') && !/\/(?:integration-tests|__tests__|migrations|models)\//.test(f))) {
  const { ast } = source(filename);
  visit(ast, node => {
    const name = callName(node);
    if (!sqlCalls.has(name)) return;
    rawSqlCandidates.push({ module: moduleOf(filename), file: relative(filename),
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, call: node.expression.getText(ast),
      status: ['product', 'pricing'].includes(moduleOf(filename)) ? 'M1-must-retain-tenant-transaction-context' : 'M2-manual-review-before-enabling',
      note: 'Static candidate only; getTransactionContext is often a safeguard, and this inventory is not a vulnerability finding.' });
  });
}
const counts = items => Object.fromEntries([...items.reduce((map, item) => map.set(item.module, (map.get(item.module) ?? 0) + 1), new Map())].sort());
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'BASELINE.json'), 'utf8'));
const inventory = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  source: { declaredBaselineCommit: baseline.source_commit, actualHead: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'packages/medusa/package.json'), 'utf8')).version,
    rootLicenseSha256: sha256(fs.readFileSync(path.join(root, 'LICENSE'))), scope: 'native packages/modules DML and Link definitions; packages/medusa/src/api route exports; current working source, including authorized patches' },
  summary: { modelFiles: modelFiles.length, dmlModels: models.length, modelFileExceptions: modelFileExceptions.length, modelsByModule: counts(models),
    physicalLinks: links.filter(link => link.table).length, readOnlyLinkDefinitions: links.filter(link => link.readOnly).length,
    routeFiles: routes.length, routeMethodPairs: routes.reduce((sum, route) => sum + route.methods.length, 0),
    uniqueIndexes: models.reduce((sum, model) => sum + model.uniqueIndexes.length + model.fields.filter(field => field.unique).length, 0), rawSqlCandidates: rawSqlCandidates.length },
  limitations: [
    'AST source inventory is not HTTP execution, a migrated database inventory, a complete security audit, or proof that all entities have tenant isolation.',
    'Primary tables without explicit tableName use the native snake-case convention; migration CREATE TABLE evidence is included where found. Generated pivots also require migration/metadata verification.',
    'Indexes and fields are direct DML source declarations. Runtime tenantScoped() transformations are indicated separately and require runtime schema/migration verification.',
    'Provider registry ownership and index/search/workflow/lock storage remain explicitly unreviewed and must stay disabled/default denied until their later phase.',
    'Route candidates do not activate routes. Auth candidates must be restricted to tested actor types and the emailpass provider, and membership/tenant/field guards must run before native APIs.',
    'Custom app/plugin APIs, dependency-provided framework endpoints, mounted Admin assets, health endpoints and future route additions are outside this native route list; the runtime guard must cover mounts too.',
    'Shared Currency is read-only. Region Country has a mutable region relationship and is intentionally tenant-owned.',
  ],
  generatedPivots: models.flatMap(model => model.fields.filter(field => field.relation?.type === 'manyToMany').map(field => ({
    module: model.module, ownerEntity: model.entity, ownerTable: model.table, field: field.name,
    declaredPivotTable: field.relation.options?.pivotTable ?? null,
    declaredPivotEntity: field.relation.options?.pivotEntity ?? null,
    nativeMigrationEvidence: field.relation.options?.pivotTable
      ? [...new Set(migrationTables.get(`${model.module}:${field.relation.options.pivotTable}`) ?? [])] : [],
    review: 'Generated pivots require tenant column, tenant-scoped uniqueness and same-tenant composite foreign keys; metadata and actual migration must agree.',
  }))),
  nativeMigrationTables: [...migrationTables].map(([key, evidence]) => ({ module: key.split(':')[0], table: key.split(':')[1], migrationFiles: [...new Set(evidence)] })),
  models, modelFileExceptions, links, routes, rawSqlCandidates,
};
const destination = path.join(__dirname, 'm1-ownership.json');
fs.writeFileSync(destination, JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify({ output: relative(destination), source: inventory.source, summary: inventory.summary }, null, 2));
