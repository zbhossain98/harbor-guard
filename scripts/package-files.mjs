// Shared release boundaries for both source archives and the extension ZIP.
export const PACKAGE_DOCUMENTS = [
  'README.md', 'package.json', '.gitignore', '.gitattributes', 'LICENSE',
  'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md',
];

const excluded = new Set([
  '.git', '.cache', '.gradle', '.cxx', '.idea', '.vscode', 'node_modules',
  'dist', 'build', '_metadata', 'local.properties', 'key.properties',
  'keystore.properties', 'credentials.json', '.ds_store', 'thumbs.db',
]);

export function excludePackageEntry(name) {
  const lower = name.toLowerCase();
  return excluded.has(lower)
    || (lower === '.env' || lower.startsWith('.env.'))
    || /\.(?:keystore|jks|p12|pfx|pem|key|log)$/i.test(name);
}
