import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { contractsDirectory, renderGeneratedContracts } from './contract-codegen.ts';

const output = join(contractsDirectory, 'generated', 'contracts.ts');
writeFileSync(output, renderGeneratedContracts(), 'utf8');
console.log(`generated ${output}`);
