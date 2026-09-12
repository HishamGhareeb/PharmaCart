import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { contractsDirectory, renderGeneratedContracts } from './contract-codegen.ts';
import { renderOpenapi } from './openapi.ts';

const output = join(contractsDirectory, 'generated', 'contracts.ts');
writeFileSync(output, renderGeneratedContracts(), 'utf8');
writeFileSync(join(contractsDirectory,'openapi.json'),renderOpenapi(),'utf8');
console.log(`generated ${output}`);
