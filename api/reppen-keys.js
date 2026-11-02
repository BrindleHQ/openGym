#!/usr/bin/env node
/* The Reppen token signing keys of the running server (reppen.js): list them, or rotate.
 *
 *   docker compose exec api node reppen-keys.js                    list the keys
 *   docker compose exec api node reppen-keys.js rotate             new key, signing in 10 minutes
 *   docker compose exec api node reppen-keys.js rotate --lead 0    new key, signing now
 *
 * The new key is published at once and signs only after the lead, so a Reppen that caches the
 * key set has it before the first token it signs arrives. Use --lead 0 only when Reppen reads
 * the key set on every unknown key id. The previous key stays published until its last token
 * has expired. Asks the running server over its admin socket (admin-socket.js), like recover.js.
 */
import { askAdminSocket, socketPath } from './admin-socket.js';

const args = process.argv.slice(2);
const rotate = args[0] === 'rotate';
const at = args.indexOf('--lead');
const lead = at >= 0 ? Number(args[at + 1]) : undefined;

if (args.includes('--help') || args.includes('-h') || (args.length && !rotate) || (at >= 0 && !rotate)) {
  console.log('usage: node reppen-keys.js   |   node reppen-keys.js rotate [--lead <seconds>]');
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 2);
}

const when = t => t == null ? '-' : new Date(t).toISOString();
try {
  const r = await askAdminSocket({ cmd: 'reppen-keys', rotate, ...(lead === undefined ? {} : { lead }) });
  if (!r.keys) { console.error(r.error || 'the server did not answer with the keys'); process.exit(1); }
  for (const k of r.keys) {
    const state = k.signing ? 'signing' : !k.published ? 'retired' : k.activeFrom > Date.now() ? 'waiting' : 'published';
    console.log(`${k.kid}  ${state.padEnd(9)}  signs from ${when(k.activeFrom)}  retires ${when(k.retireAt)}`);
  }
  process.exit(0);
} catch (e) {
  if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
    console.error(`The openGym server is not running here (no ${socketPath()}). Start it first, then run this again inside it.`);
  } else {
    console.error('Could not ask the server:', e.message);
  }
  process.exit(1);
}
