import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { contractsDirectory, renderGeneratedContracts } from './contract-codegen.ts';
import { renderOpenapi } from './openapi.ts';

const generatedPath = join(contractsDirectory, 'generated', 'contracts.ts');
const actual = readFileSync(generatedPath, 'utf8');
const expected = renderGeneratedContracts();
if(readFileSync(join(contractsDirectory,'openapi.json'),'utf8')!==renderOpenapi())throw new Error('OpenAPI is stale; run npm run contracts:generate');

if (actual !== expected) {
  console.error('generated contracts are stale; run scripts/generate-contracts.ts');
  process.exitCode = 1;
} else {
  console.log('contracts verified');
}
