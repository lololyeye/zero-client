// Creates the Ed25519 key that signs ZERO's update manifests, once, outside the repository.
// The private key stays on the maintainer's machine (back it up: without it, quick updates cannot be signed).
// Prints the public key to paste into src/shared/updateKey.ts.
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const keyPath = () => process.env.ZERO_UPDATE_KEY || path.join(homedir(), '.zero-release', 'update-signing-key.pem');

const file = keyPath();
if (!existsSync(file)) {
  mkdirSync(path.dirname(file), { recursive: true });
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  console.log(`created ${file}`);
}
const pub = createPublicKey(createPrivateKey(readFileSync(file))).export({ format: 'der', type: 'spki' }).toString('base64');
console.log(`public key: ${pub}`);
