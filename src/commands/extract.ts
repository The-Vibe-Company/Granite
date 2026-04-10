import { jsonSuccess } from '../core/json-output.js';
import { extractDocument } from '../core/extract-document.js';

interface ExtractOptions {
  json?: boolean;
}

export async function extractDocumentCommand(filePath: string, options: ExtractOptions = {}): Promise<void> {
  let extracted;

  try {
    extracted = await extractDocument(filePath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (options.json) {
    console.log(jsonSuccess(extracted));
    return;
  }

  console.log(`Status: ${extracted.status}`);
  console.log(`Document type: ${extracted.doc_type}`);
  console.log(`Extractor: ${extracted.extractor}`);
  console.log(`Reading basis: ${extracted.reading_basis}`);
  console.log(`Confidence: ${extracted.confidence}`);
  console.log(`Title hint: ${extracted.title_hint}`);

  if (extracted.limits.length > 0) {
    console.log('');
    console.log('Limits:');
    for (const limit of extracted.limits) {
      console.log(`- ${limit}`);
    }
  }

  if (extracted.status === 'needs_dependency') {
    console.log('');
    console.log(`Missing dependency: ${extracted.missing_dependency}`);
    if (extracted.install_source_url) {
      console.log(`Install source: ${extracted.install_source_url}`);
    }
    if (extracted.verify_command) {
      console.log(`Verify command: ${extracted.verify_command}`);
    }
    if (extracted.install_instructions) {
      console.log(`Platform: ${extracted.install_instructions.platform}`);
      console.log('Install steps:');
      extracted.install_instructions.steps.forEach((step, index) => {
        console.log(`${index + 1}. ${step}`);
      });
      if (extracted.install_instructions.notes.length > 0) {
        console.log('Notes:');
        for (const note of extracted.install_instructions.notes) {
          console.log(`- ${note}`);
        }
      }
    }
    if (extracted.user_prompt) {
      console.log('');
      console.log(`User prompt: ${extracted.user_prompt}`);
    }
    return;
  }

  if (extracted.raw_text) {
    console.log('');
    console.log(extracted.raw_text);
  }
}
