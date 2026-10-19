import { readFile } from 'node:fs/promises';
import { parseAllDocuments } from 'yaml';
const files = ['deploy/kubernetes.yaml', 'deploy/kubernetes.test.yaml', 'deploy/compose.test.yaml', 'deploy/aws/template.yaml', 'compose.yaml', '.github/workflows/ci.yml', '.github/workflows/deploy-aws.yml'];
for (const file of files) {
  const documents = parseAllDocuments(await readFile(file, 'utf8'), { uniqueKeys: true });
  for (const document of documents) if (document.errors.length) throw new Error(`${file}: ${document.errors.map(error => error.message).join('; ')}`);
}
console.log('Deployment and CI YAML syntax checks passed.');
