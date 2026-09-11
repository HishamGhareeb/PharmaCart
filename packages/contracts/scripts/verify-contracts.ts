import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { contractsDirectory, renderGeneratedContracts } from './contract-codegen.ts';

const generatedPath = join(contractsDirectory, 'generated', 'contracts.ts');
const actual = readFileSync(generatedPath, 'utf8');
const expected = renderGeneratedContracts();

if (actual !== expected) {
  console.error('generated contracts are stale; run scripts/generate-contracts.ts');
  process.exitCode = 1;
} else {
  console.log('contracts verified');
}
