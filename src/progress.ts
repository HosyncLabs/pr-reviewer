import { secureStorage } from './storage';
import { emptyFileProgress, sameDiffRevision, PROGRESS_NOTICE, type ReviewProgress } from './workflow';
import type { ExtensionRequest } from './ai-protocol';

const keyFor = (scope: string) => `pr-reviewer:progress:${scope}`;
let writes = Promise.resolve();
export async function loadProgressTrusted(scope: string): Promise<ReviewProgress> {
  await secureStorage();
  const value = (await chrome.storage.local.get(keyFor(scope)))[keyFor(scope)] as ReviewProgress | undefined;
  return value && typeof value === 'object' && value.files && typeof value.lastFile === 'string' ? value : { files: {}, lastFile: '' };
}
export function saveProgressTrusted(scope: string, request: Extract<ExtensionRequest, { type: 'progress-save' }>): Promise<ReviewProgress> {
  const run = writes.then(async () => {
    const progress = await loadProgressTrusted(scope);
    let file = Object.hasOwn(progress.files, request.path) ? progress.files[request.path] : emptyFileProgress();
    if (request.revision && request.revision !== file.revision) file = sameDiffRevision(file.revision, request.revision) ? { ...file, revision: request.revision } : { ...emptyFileProgress(request.revision), note: file.note };
    file = { ...file, blocks: { ...file.blocks }, checks: { ...file.checks } };
    if (request.reviewed !== undefined) file.reviewed = request.reviewed;
    if (request.note !== undefined) file.note = request.note;
    if (request.block) {
      if (request.block.state) file.blocks[request.block.key] = request.block.state;
      else delete file.blocks[request.block.key];
      if (Object.keys(file.blocks).length > 200) throw new Error('Too many saved review blocks for this file.');
    }
    if (request.check) file.checks[request.check.key] = request.check.checked;
    progress.files = { ...progress.files, [request.path]: file };
    if (request.lastFile) progress.lastFile = request.path;
    if (Object.keys(progress.files).length > 3000) throw new Error('This PR exceeds the progress limit.');
    await chrome.storage.local.set({ [keyFor(scope)]: progress });
    await chrome.storage.session.set({ [PROGRESS_NOTICE]: { scope, nonce: crypto.randomUUID() } });
    return progress;
  });
  writes = run.then(() => {}, () => {});
  return run;
}
