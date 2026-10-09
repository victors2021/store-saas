const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const expectedLicense = 'f792b19e548b936c2a9a8e489e2f21e3b5a91e482910c57d9c9508f8933789af';
if (crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'LICENSE'))).digest('hex') !== expectedLicense) {
  throw new Error('Review source license before continuing');
}
if (fs.existsSync(path.join(root, 'ENTERPRISE-LICENSE.md'))) {
  throw new Error('Enterprise source has entered the MIT candidate');
}
for (const name of ['@medusajs/product', '@medusajs/pricing', '@medusajs/framework', '@medusajs/loyalty-plugin']) {
  // Read workspace metadata directly; framework intentionally does not export
  // package.json as a runtime subpath.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
  if (pkg.version !== '2.18.0') throw new Error(`Mixed baseline version: ${name}`);
}
for (const file of [
  'packages/plugins/loyalty/.medusa/server/src/workflows/hooks/after-order-credit-lines-created.js',
  'packages/plugins/loyalty/.medusa/server/src/modules/store-credit/index.js',
]) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Required plugin output missing: ${file}. Run build:plugin.`);
}
console.log('MIT source/version and required Loyalty plugin outputs verified');
