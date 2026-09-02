// Integration contract: the public doctor execution path must make the live
// serving verdict authoritative, rather than leaving applyServingVerdict as an
// isolated helper that production never calls.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/doctor.ts', import.meta.url), 'utf8');

assert.match(source, /import \{ applyServingVerdict \} from ['"]\.\/doctor-serving\.js['"]/);
assert.match(source, /const checks = await collectChecks\(opts\)/);
assert.match(source, /if \(!opts\.probe\) return checks/);
assert.match(source, /const probe = await getServingProbe\(/);
assert.match(source, /return applyServingVerdict\(checks, probe\)/);

console.log('doctor serving production integration: ok');
