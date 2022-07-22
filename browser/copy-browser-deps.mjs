import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const scriptDir = fileURLToPath(path.dirname(import.meta.url));

const browserDependencies = [
    [ "styles.css" ]
];

const destinationRoot = "../out/browser";

for (const relativePath of browserDependencies) {
    const sourcePath = path.join(scriptDir, ...relativePath);
    const destinationPath = path.join(scriptDir, destinationRoot, ...relativePath);    
    fs.copyFileSync(sourcePath, destinationPath);
}